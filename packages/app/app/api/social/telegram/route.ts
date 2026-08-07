import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/oracle';
import { safeEqual } from '@/lib/safeCompare';
import {
  answerCallback, markCardHandled, notify, sendReplyCard,
  sendDraftCard, markDraftHandled,
  sendPreviewCard, refreshPreviewCard, sendPhotoPreview,
} from '@/lib/social/telegram';
import {
  setMedia, autoCardUrl, awaitMediaFor, clearAwaitingMedia, pendingMediaPost,
} from '@/lib/social/media';
import { handleCommand, isMultiMessageCommand, commandName } from '@/lib/social/commands';
import { parseBrief, draftFromBrief } from '@/lib/social/brief';
import { nextFreeSlot, formatSlot } from '@/lib/social/slots';
import { ingestShared } from '@/lib/social/ingest';
import { getSettings } from '@/lib/social/settings';
import { draftReply } from '@/lib/social/reply';

// POST /api/social/telegram
//
// Telegram webhook. Handles the button taps on a reply card.
//
// Auth is the secret-token header Telegram echoes back on every
// delivery. This endpoint is necessarily public — Telegram's servers
// call it — so without that check anyone who found the URL could mark
// replies as posted and corrupt the funnel numbers.
//
// Note what this endpoint deliberately does NOT do: it does not post to
// X. "Posted" means the operator already pasted it in the native app.
// Sending via API would cost $0.015 a reply — about $18/month at 40 a
// day, roughly 3x the entire budget — and native posts carry better
// distribution anyway. The button is bookkeeping, not a trigger.

export const dynamic = 'force-dynamic';

/**
 * The share-to-bot path: operator sends a post (link or text), we draft
 * a reply and send back the same card a scan would have produced.
 *
 * Costs nothing by default. Drafting is Gemini; reading the shared post
 * uses free oEmbed, and only touches the billed X API if the operator
 * turned that on with /paidlookup.
 */
async function handleShare(raw: string): Promise<void> {
  const settings = await getSettings();
  const result = await ingestShared(raw, { allowPaidLookup: settings.allowPaidLookup });

  if (!result.ok) {
    await notify(result.hint);
    return;
  }

  const { post } = result;
  const supa = getSupabaseAdmin();

  // Already drafted against this post? Hand back what we have rather
  // than paying Gemini again and buzzing twice for the same thing.
  const { data: existing } = await supa
    .from('social_replies')
    .select('id, draft_body, status')
    .eq('source_post_id', post.postId)
    .maybeSingle();

  if (existing) {
    await notify(
      `Already drafted this one (<b>${existing.status}</b>):\n\n` +
      `<code>${String(existing.draft_body).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`,
    );
    return;
  }

  const draft = await draftReply({
    authorHandle: post.author,
    authorLabel: null,
    sourceText: post.text,
  });

  if (!draft) {
    // draftReply returns null on a compliance rejection or a SKIP —
    // sensitive topics are deliberately left alone.
    await notify(
      `No draft for that one. Either it tripped a compliance rule, or it's the kind of ` +
      `post (tragedy, crime, active political conflict) the drafter is told to skip.\n\n` +
      `Send it again with your own angle and I'll work from that.`,
    );
    return;
  }

  const { data: row, error } = await supa
    .from('social_replies')
    .insert({
      source_post_id: post.postId,
      source_author: post.author,
      source_text: post.text.slice(0, 1000),
      source_url: post.url,
      origin: 'shared',
      draft_body: draft,
      status: 'drafted',
    })
    .select('id')
    .single();

  if (error || !row) {
    await notify(`Drafted it but couldn't save: ${error?.message ?? 'unknown error'}`);
    return;
  }

  const messageId = await sendReplyCard({
    replyId: row.id,
    author: post.author,
    sourceText: post.text,
    sourcePostId: post.postId,
    draft,
  });

  await supa
    .from('social_replies')
    .update({ status: 'sent_to_review', telegram_message_id: messageId })
    .eq('id', row.id);
}

/**
 * `/draft 4 BBN posts` — write posts from the operator's own brief.
 *
 * The subject comes from the operator, not the market table. That is
 * the entire point: ranking open markets by closing time surfaced Dutch
 * second-division fixtures with nothing to say about them, and no
 * prompt fixes a bad subject. Live markets are still offered to the
 * model as optional context, to be ignored when the brief is about
 * something else.
 */
async function handleDraft(raw: string): Promise<void> {
  const req = parseBrief(raw);

  if (!req.brief || req.brief.length < 2) {
    await notify(
      `What should I write about?\n\n` +
      `<code>/draft 4 BBN posts</code>\n` +
      `<code>/draft 3 posts about the Super Eagles squad</code>`,
    );
    return;
  }

  // Gemini takes a few seconds for four posts. Without this the bot
  // looks dead.
  await notify(
    `Researching <i>${escapeHtml(req.brief)}</i>, then writing ${req.count} post${req.count === 1 ? '' : 's'}…`,
  );

  let result;
  try {
    result = await draftFromBrief(req);
  } catch (e: any) {
    await notify(`Drafting failed: ${String(e?.message ?? e).slice(0, 200)}`);
    return;
  }

  if (!result.drafts.length) {
    const why = result.rejected.length
      ? `\n\nAll ${result.rejected.length} were rejected by a compliance guard: ` +
        result.rejected.map((r) => r.reason).join('; ').slice(0, 300)
      : '';
    await notify(`Nothing usable came back for that brief.${why}\n\nTry rephrasing it.`);
    return;
  }

  // Show the findings BEFORE the drafts. The operator is the only one
  // who can tell whether a "fact" from a search result is actually
  // true, and they should get that chance while the posts are still
  // drafts rather than after one has published.
  if (result.research) {
    const src = result.research.sources.length
      ? `\n\n<i>Sources: ${escapeHtml(result.research.sources.join(', '))}</i>`
      : '';
    await notify(
      `<b>What I found</b>\n\n${escapeHtml(result.research.findings.slice(0, 2500))}${src}`,
    ).catch(() => {});
  } else {
    await notify(
      `<i>No recent news found for that brief — the posts below are written from general knowledge, ` +
      `so they may read generic. A more specific brief usually helps.</i>`,
    ).catch(() => {});
  }

  const supa = getSupabaseAdmin();
  let sent = 0;

  for (const body of result.drafts) {
    const { data: row, error } = await supa
      .from('social_posts')
      .insert({
        channel: 'x',
        kind: 'briefed',
        body,
        brief: req.brief,
        status: 'draft',      // outside the queue — cannot publish
        scheduled_at: null,   // a slot is chosen when you tap Queue
        priority: 50,         // ahead of evergreen filler once queued
      })
      .select('id')
      .single();

    if (error || !row) continue;

    const messageId = await sendDraftCard({
      postId: row.id,
      index: sent + 1,
      total: result.drafts.length,
      body,
    });

    // Reuse provider_post_id to remember which card to edit later. It
    // is null until publish, and a draft has no provider id yet.
    await supa
      .from('social_posts')
      .update({ provider_post_id: `tg:${messageId}` })
      .eq('id', row.id);

    sent++;
  }

  if (result.rejected.length) {
    await notify(
      `(${result.rejected.length} draft${result.rejected.length === 1 ? '' : 's'} dropped by a ` +
      `compliance guard: ${result.rejected.map((r) => r.reason).join('; ').slice(0, 200)})`,
    );
  }
}

/** Re-send anything still sitting undecided. */
async function handlePendingDrafts(): Promise<void> {
  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from('social_posts')
    .select('id, body, brief')
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(10);

  if (!data?.length) {
    await notify(`No drafts waiting. <code>/draft 4 BBN posts</code> to write some.`);
    return;
  }

  for (let i = 0; i < data.length; i++) {
    const messageId = await sendDraftCard({
      postId: data[i].id,
      index: i + 1,
      total: data.length,
      body: String(data[i].body),
    });
    await supa
      .from('social_posts')
      .update({ provider_post_id: `tg:${messageId}` })
      .eq('id', data[i].id);
  }
}

/** Queue or discard one draft, from a button tap. */
async function decideDraft(postId: number, queue: boolean): Promise<string> {
  const supa = getSupabaseAdmin();

  const { data: post } = await supa
    .from('social_posts')
    .select('id, provider_post_id, status')
    .eq('id', postId)
    .maybeSingle();

  if (!post || post.status !== 'draft') return 'Already handled';

  const messageId = Number(String(post.provider_post_id ?? '').replace(/^tg:/, '')) || 0;

  if (!queue) {
    await supa
      .from('social_posts')
      .update({ status: 'cancelled', provider_post_id: null })
      .eq('id', postId)
      .eq('status', 'draft');
    if (messageId) await markDraftHandled(messageId, 'discarded').catch(() => {});
    return 'Discarded';
  }

  const slot = await nextFreeSlot();
  if (!slot) {
    return 'No free slot in the next 3 days — publish or /skip something first';
  }

  const { data: updated } = await supa
    .from('social_posts')
    .update({
      status: 'queued',
      scheduled_at: slot.toISOString(),
      provider_post_id: null,   // back to meaning "the X post id"
    })
    .eq('id', postId)
    .eq('status', 'draft')      // compare-and-set: a double tap is a no-op
    .select('id');

  if (!updated?.length) return 'Already handled';

  const when = formatSlot(slot);
  if (messageId) await markDraftHandled(messageId, 'queued', when).catch(() => {});
  return `Queued ${when} — /preview to add an image`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── preview + media ─────────────────────────────────────────────────

type QueuedRow = {
  id: number;
  body: string;
  scheduled_at: string | null;
  media_kind: 'none' | 'auto_card' | 'upload';
  media_url: string | null;
};

async function loadQueued(limit = 10): Promise<QueuedRow[]> {
  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from('social_posts')
    .select('id, body, scheduled_at, media_kind, media_url')
    .eq('status', 'queued')
    .not('scheduled_at', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(limit);
  return (data ?? []) as QueuedRow[];
}

/**
 * `/preview` — everything queued, with its image, before it goes out.
 *
 * This is the last place a post can be looked at as a whole: the words
 * and the picture together, in the order they will publish.
 */
async function handlePreview(): Promise<void> {
  const rows = await loadQueued();

  if (!rows.length) {
    await notify(`Nothing queued.\n\n<code>/draft 4 BBN posts</code> to write some.`);
    return;
  }

  await notify(`<b>${rows.length} post${rows.length === 1 ? '' : 's'} queued</b> — oldest slot first.`);

  const supa = getSupabaseAdmin();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const messageId = await sendPreviewCard({
      postId: r.id,
      index: i + 1,
      total: rows.length,
      body: r.body,
      when: r.scheduled_at ? formatSlot(new Date(r.scheduled_at)) : 'unscheduled',
      mediaKind: r.media_kind,
    });
    // Remember the card so a button tap can redraw it in place.
    await supa
      .from('social_posts')
      .update({ provider_post_id: `tg:${messageId}` })
      .eq('id', r.id);
  }
}

/** Redraw one preview card after its media changed. */
async function refreshOne(postId: number): Promise<void> {
  const supa = getSupabaseAdmin();
  const { data: p } = await supa
    .from('social_posts')
    .select('id, body, scheduled_at, media_kind, provider_post_id')
    .eq('id', postId)
    .maybeSingle();
  if (!p) return;

  const messageId = Number(String((p as any).provider_post_id ?? '').replace(/^tg:/, '')) || 0;
  if (!messageId) return;

  await refreshPreviewCard(messageId, {
    postId,
    index: 1,
    total: 1,
    body: String((p as any).body),
    when: (p as any).scheduled_at ? formatSlot(new Date((p as any).scheduled_at)) : 'unscheduled',
    mediaKind: (p as any).media_kind,
  }).catch(() => {});
}

/** A media button on a preview card. */
async function decideMedia(postId: number, action: string): Promise<string> {
  const supa = getSupabaseAdmin();
  const { data: p } = await supa
    .from('social_posts')
    .select('id, status, body, brief')
    .eq('id', postId)
    .maybeSingle();

  if (!p || !['queued', 'draft'].includes(String((p as any).status))) {
    return 'Post is no longer editable';
  }

  if (action === 'mnone') {
    await setMedia(postId, 'none');
    await clearAwaitingMedia().catch(() => {});
    await refreshOne(postId);
    return 'Image removed';
  }

  if (action === 'mcard') {
    await setMedia(postId, 'auto_card');
    await refreshOne(postId);
    // Show the render, not just the label — "an image is attached" is
    // not the same claim as "this image is attached".
    await sendPhotoPreview(autoCardUrl(postId), `Card for <b>#${postId}</b>`).catch(async (e) => {
      await notify(`Card set, but the preview render failed: ${String(e?.message).slice(0, 150)}`);
    });
    return 'OPx card attached';
  }

  if (action === 'mup') {
    await awaitMediaFor(postId);
    await notify(
      `Send me the photo for <b>#${postId}</b> now.\n\n` +
      `Just send it as a photo — no caption needed. Expires in 10 minutes.`,
    );
    return 'Waiting for your photo';
  }

  return 'Nothing to do';
}

/**
 * A photo arrived. Attach it to whichever post is waiting.
 *
 * Two ways to say which post: reply to its preview card, or tap Upload
 * first. Replying is unambiguous, so it wins when both are in play.
 */
async function handlePhoto(update: any): Promise<void> {
  const photos = update?.message?.photo;
  if (!Array.isArray(photos) || !photos.length) return;

  // Telegram sends every size; the last is the largest.
  const fileId = photos[photos.length - 1]?.file_id;
  if (!fileId) return;

  const supa = getSupabaseAdmin();
  let postId: number | null = null;

  const repliedTo = Number(update?.message?.reply_to_message?.message_id ?? 0);
  if (repliedTo) {
    const { data } = await supa
      .from('social_posts')
      .select('id')
      .eq('provider_post_id', `tg:${repliedTo}`)
      .maybeSingle();
    if (data) postId = Number((data as any).id);
  }

  if (!postId) postId = await pendingMediaPost();

  if (!postId) {
    await notify(
      `Got the photo, but I don't know which post it's for.\n\n` +
      `Tap <b>📤 Upload</b> on a post in /preview first, or reply to that post's card with the photo.`,
    );
    return;
  }

  await setMedia(postId, 'upload', { fileId });
  await clearAwaitingMedia();
  await refreshOne(postId);
  await notify(`Attached your image to <b>#${postId}</b>.`);
}

export async function POST(request: Request) {
  const provided = request.headers.get('x-telegram-bot-api-secret-token');
  if (!safeEqual(provided, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    // 200, not 401. Telegram retries non-2xx responses for a long time,
    // and there is nothing to retry here.
    return NextResponse.json({ ok: true });
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const cb = update?.callback_query;
  if (!cb) {
    // A photo has no .text, so it must be handled before the empty
    // check below drops it.
    if (update?.message?.photo) {
      const photoFrom = String(update?.message?.from?.id ?? '');
      if (photoFrom === String(process.env.TELEGRAM_CHAT_ID ?? '')) {
        try {
          await handlePhoto(update);
        } catch (e: any) {
          await notify(`Couldn't attach that photo: ${String(e?.message ?? e).slice(0, 200)}`)
            .catch(() => {});
        }
      }
      return NextResponse.json({ ok: true });
    }

    const raw = String(update?.message?.text ?? '').trim();
    if (!raw) return NextResponse.json({ ok: true });

    // Only the configured operator may drive this. Telegram delivers
    // every message the bot can see, and the bot's username is
    // guessable — without this, a stranger who finds it could pause
    // publishing or burn budget on paid lookups.
    const fromId = String(update?.message?.from?.id ?? '');
    if (fromId !== String(process.env.TELEGRAM_CHAT_ID ?? '')) {
      return NextResponse.json({ ok: true });
    }

    try {
      if (isMultiMessageCommand(raw)) {
        // These send a card per draft rather than one reply.
        const cmd = commandName(raw);
        if (cmd === '/drafts') await handlePendingDrafts();
        else if (cmd === '/preview') await handlePreview();
        else await handleDraft(raw);
      } else if (raw.startsWith('/')) {
        await notify(await handleCommand(raw));
      } else {
        await handleShare(raw);
      }
    } catch (e: any) {
      await notify(`Something broke handling that: ${String(e?.message ?? e).slice(0, 200)}`)
        .catch(() => {});
    }

    return NextResponse.json({ ok: true });
  }

  // Buttons on a callback are only as trustworthy as who tapped them.
  // Telegram reports the tapper, and it need not be the same person the
  // card was sent to.
  const cbFrom = String(cb.from?.id ?? '');
  if (cbFrom !== String(process.env.TELEGRAM_CHAT_ID ?? '')) {
    await answerCallback(cb.id, 'Not authorised').catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const data = String(cb.data ?? '');
  const [action, rawId] = data.split(':');
  const targetId = Number(rawId);

  // Draft cards (qpost/dpost) act on social_posts; reply cards
  // (posted/skip) act on social_replies. Different tables, so they
  // dispatch separately.
  if (['mcard', 'mup', 'mnone'].includes(action)) {
    if (!Number.isFinite(targetId)) {
      await answerCallback(cb.id, 'Nothing to do').catch(() => {});
      return NextResponse.json({ ok: true });
    }
    const outcome = await decideMedia(targetId, action);
    await answerCallback(cb.id, outcome).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  if (action === 'pcancel') {
    const supa = getSupabaseAdmin();
    const { data } = await supa
      .from('social_posts')
      .update({ status: 'cancelled', last_error: 'cancelled from preview' })
      .eq('id', targetId)
      .in('status', ['queued', 'draft'])
      .select('id');
    await answerCallback(cb.id, data?.length ? 'Post cancelled' : 'Already handled').catch(() => {});
    return NextResponse.json({ ok: true });
  }

  if (['qpost', 'dpost'].includes(action)) {
    if (!Number.isFinite(targetId)) {
      await answerCallback(cb.id, 'Nothing to do').catch(() => {});
      return NextResponse.json({ ok: true });
    }
    const outcome = await decideDraft(targetId, action === 'qpost');
    await answerCallback(cb.id, outcome).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const replyId = targetId;
  if (!Number.isFinite(replyId) || !['posted', 'skip'].includes(action)) {
    await answerCallback(cb.id, 'Nothing to do').catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const supa = getSupabaseAdmin();

  // Only move rows still awaiting a decision, so a double-tap on an old
  // card cannot flip an already-resolved row.
  const { data: updated } = await supa
    .from('social_replies')
    .update(
      action === 'posted'
        ? { status: 'posted', posted_via: 'manual', approved_at: new Date().toISOString() }
        : { status: 'rejected' },
    )
    .eq('id', replyId)
    .in('status', ['drafted', 'sent_to_review'])
    .select('id, telegram_message_id');

  if (!updated?.length) {
    await answerCallback(cb.id, 'Already handled').catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const messageId = Number(updated[0].telegram_message_id ?? cb.message?.message_id ?? 0);
  if (messageId) {
    await markCardHandled(messageId, action === 'posted' ? 'posted' : 'skipped').catch(() => {});
  }

  await answerCallback(cb.id, action === 'posted' ? 'Logged ✅' : 'Skipped').catch(() => {});
  return NextResponse.json({ ok: true });
}
