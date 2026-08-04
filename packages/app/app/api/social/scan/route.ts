import { NextResponse } from 'next/server';
import { safeSecretMatch } from '@/lib/safeCompare';
import { getSupabaseAdmin } from '@/lib/oracle';
import { lookupUserId, fetchRecentPosts, isXConfigured } from '@/lib/social/x';
import { budgetSummary, monthlyCapUsd, spentThisMonthUsd } from '@/lib/social/budget';
import { sendReplyCard, notify } from '@/lib/social/telegram';
import { draftReply } from '@/lib/social/reply';

// POST /api/social/scan
//
// Reads the monitored accounts, drafts a reply to anything new, and
// pushes each draft to Telegram for a human.
//
// This route only exists because of the Feb 2026 pricing change. Under
// the old free tier, reads were ~50/day with no search — you could not
// listen to a timeline at all, and the whole reply strategy was
// impossible. Metered pay-per-use makes it possible at $0.005/read,
// which is the single best thing about the new model for an account
// this size.
//
// THE BUDGET MATH — read this before adding targets.
//
// X's user-timeline endpoint has a floor of 5 results per call, so the
// cheapest possible poll of one account is 5 x $0.005 = $0.025. We only
// ever USE the newest post, so that floor is the true unit cost of
// watching one account once.
//
//   6 targets x 2 scans/day x $0.025 = $0.30/day = $9.00/month
//
// That alone exceeds a ~$6.50 budget, which is why since_id matters so
// much: a target with nothing new returns zero rows, and
// fetchRecentPosts refunds the whole reservation. In practice only
// about half the polls are billable, landing near $4.50/month and
// leaving room for publishing's ~$1.80.
//
// The consequence, stated plainly: on a ₦10k budget this supports
// roughly SIX monitored accounts scanned TWICE a day. Adding a seventh
// is a real cost decision, not a config tweak. Raise
// SOCIAL_MONTHLY_BUDGET_USD before raising SOCIAL_MAX_READS_PER_RUN.

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** X's minimum for this endpoint. Asking for fewer is not possible. */
const POSTS_PER_TARGET = 5;

/**
 * Hard ceiling per run. Default 15 = three targets' worth, which with
 * two scans a day and since_id refunds fits the budget above.
 */
function maxReadsPerRun(): number {
  const n = Number(process.env.SOCIAL_MAX_READS_PER_RUN);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/**
 * Leave this share of the monthly budget for publishing.
 *
 * Reads are the greedy side of the system — a scan can burn a week of
 * posting budget in one run if a batch of targets all went active. The
 * original posts are the thing we committed to; replies are upside. So
 * scanning stops early while publishing still has room.
 */
const PUBLISH_RESERVE_FRACTION = 0.35;

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!safeSecretMatch(cronSecret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isXConfigured()) {
    return NextResponse.json({ drafted: 0, halted: 'X credentials not configured' });
  }

  const supa = getSupabaseAdmin();
  const drafted: Array<{ handle: string; sourceId: string }> = [];
  const errors: string[] = [];
  const readCeiling = maxReadsPerRun();
  let readsUsed = 0;

  // Refuse to start if publishing's reserve is already the only thing
  // left. Checked up front so we do not read a single timeline we
  // cannot afford.
  const cap = monthlyCapUsd();
  const spent = await spentThisMonthUsd().catch(() => cap);
  const scanCeiling = cap * (1 - PUBLISH_RESERVE_FRACTION);
  if (spent >= scanCeiling) {
    return NextResponse.json({
      drafted: 0,
      halted: `scan budget reached — $${spent.toFixed(3)} spent, scanning stops at $${scanCeiling.toFixed(2)} to protect publishing`,
      budget: await budgetSummary().catch(() => null),
    });
  }

  const { data: targets, error: targetErr } = await supa
    .from('social_targets')
    .select('id, handle, provider_user_id, label, poll_weight, last_seen_post_id, last_scanned_at')
    .eq('active', true)
    .order('poll_weight', { ascending: true })
    .order('last_scanned_at', { ascending: true, nullsFirst: true })
    .limit(30);

  if (targetErr) {
    return NextResponse.json({ error: `target load failed: ${targetErr.message}` }, { status: 500 });
  }

  for (const t of targets ?? []) {
    if (readsUsed + POSTS_PER_TARGET > readCeiling) break;

    // poll_weight 1 = every scan, 2 = every other, 3 = every third.
    // Cheap sampling for the long tail without a scheduler.
    const weight = Math.max(1, Number(t.poll_weight) || 1);
    if (weight > 1) {
      const lastScan = t.last_scanned_at ? new Date(t.last_scanned_at as string).getTime() : 0;
      const hoursSince = (Date.now() - lastScan) / 3_600_000;
      if (hoursSince < weight * 4) continue;
    }

    try {
      // Resolve and cache the numeric id — it bills, and it never changes.
      let userId = t.provider_user_id as string | null;
      if (!userId) {
        userId = await lookupUserId(t.handle as string);
        await supa.from('social_targets').update({ provider_user_id: userId }).eq('id', t.id);
      }

      const posts = await fetchRecentPosts(userId, {
        maxResults: POSTS_PER_TARGET,
        sinceId: (t.last_seen_post_id as string) || undefined,
      });
      readsUsed += POSTS_PER_TARGET;

      await supa
        .from('social_targets')
        .update({ last_scanned_at: new Date().toISOString() })
        .eq('id', t.id);

      if (!posts.length) continue;

      // Newest first from X; take the single most recent. One reply per
      // account per scan — replying to five posts from the same person
      // in a row reads as a bot no matter how good the copy is.
      const newest = posts[0];

      const draft = await draftReply({
        authorHandle: t.handle as string,
        authorLabel: (t.label as string) || null,
        sourceText: newest.text,
      });

      if (!draft) {
        errors.push(`@${t.handle}: draft failed or non-compliant`);
      } else {
        const { data: row, error: insErr } = await supa
          .from('social_replies')
          .insert({
            target_id: t.id,
            source_post_id: newest.id,
            source_author: t.handle,
            source_text: newest.text.slice(0, 1000),
            draft_body: draft,
            status: 'drafted',
          })
          .select('id')
          .single();

        if (insErr) {
          // 23505 = we already drafted against this post.
          if (!String(insErr.code).startsWith('23505')) {
            errors.push(`@${t.handle}: insert failed — ${insErr.message}`);
          }
        } else {
          try {
            const messageId = await sendReplyCard({
              replyId: row.id,
              author: t.handle as string,
              sourceText: newest.text,
              sourcePostId: newest.id,
              draft,
            });
            await supa
              .from('social_replies')
              .update({ status: 'sent_to_review', telegram_message_id: messageId })
              .eq('id', row.id);
            drafted.push({ handle: t.handle as string, sourceId: newest.id });
          } catch (e: any) {
            errors.push(`@${t.handle}: telegram push failed — ${e?.message}`);
          }
        }
      }

      // Advance the watermark regardless of whether drafting worked, so
      // a bad draft does not make us pay to re-read the same post.
      await supa
        .from('social_targets')
        .update({ last_seen_post_id: newest.id })
        .eq('id', t.id);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      errors.push(`@${t.handle}: ${msg.slice(0, 160)}`);
      if (msg.startsWith('budget:')) break;
    }
  }

  if (errors.length) {
    await notify(
      `<b>Scan issues</b>\n${errors.slice(0, 6).map((e) => `· ${e}`).join('\n')}`,
    ).catch(() => {});
  }

  return NextResponse.json({
    drafted: drafted.length,
    details: drafted,
    readsUsed,
    errors,
    budget: await budgetSummary().catch(() => null),
  });
}
