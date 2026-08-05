import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/oracle';
import { safeEqual } from '@/lib/safeCompare';
import { answerCallback, markCardHandled, notify, sendReplyCard } from '@/lib/social/telegram';
import { handleCommand } from '@/lib/social/commands';
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
      if (raw.startsWith('/')) {
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

  const data = String(cb.data ?? '');
  const [action, rawId] = data.split(':');
  const replyId = Number(rawId);

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
