import { NextResponse } from 'next/server';
import { safeSecretMatch } from '@/lib/safeCompare';
import { getSupabaseAdmin } from '@/lib/oracle';
import { postToX, uploadMedia, XApiError, isXConfigured } from '@/lib/social/x';
import { budgetSummary } from '@/lib/social/budget';
import { notify } from '@/lib/social/telegram';

// POST /api/social/publish
//
// Runs hourly. Publishes whatever is due, then stops.
//
// Three properties matter more than throughput here:
//
//  1. It claims rows before posting. Two overlapping cron runs must not
//     both publish the same post — GitHub Actions retries, and a
//     duplicate post from a brand account is a visible embarrassment.
//  2. It stops at the first budget refusal rather than grinding through
//     the queue collecting failures.
//  3. It caps itself per run. A backlog after downtime must not fire
//     twelve posts into the timeline in one minute; that is what a
//     spam filter is built to catch.

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Never more than this many in one run, however big the backlog. */
const MAX_PER_RUN = 2;

/**
 * A post more than this far past its slot is stale. Publishing
 * yesterday's "closes in 2 hours" post is worse than not publishing.
 */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!safeSecretMatch(cronSecret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Clean no-op until the keys exist. The queue is left completely
  // untouched, so the cron can ship before the X account does.
  if (!isXConfigured()) {
    return NextResponse.json({
      published: 0,
      skipped: [{ id: 0, reason: 'X credentials not configured — queue left intact' }],
    });
  }

  const supa = getSupabaseAdmin();
  const now = new Date();
  const published: Array<{ id: number; postId: string }> = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  const failed: Array<{ id: number; error: string }> = [];
  let budgetHalt: string | null = null;

  const { data: due, error: dueErr } = await supa
    .from('social_posts')
    .select('id, body, media_url, kind, scheduled_at, attempts, source_market_id')
    .eq('status', 'queued')
    .eq('channel', 'x')
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', now.toISOString())
    .lt('attempts', 3)
    .order('priority', { ascending: true })
    .order('scheduled_at', { ascending: true })
    .limit(MAX_PER_RUN * 3);

  if (dueErr) {
    return NextResponse.json({ error: `queue read failed: ${dueErr.message}` }, { status: 500 });
  }

  for (const post of due ?? []) {
    if (published.length >= MAX_PER_RUN) break;

    // Drop anything that missed its window rather than posting it late.
    const scheduled = new Date(post.scheduled_at as string).getTime();
    if (now.getTime() - scheduled > STALE_AFTER_MS) {
      await supa
        .from('social_posts')
        .update({ status: 'skipped', last_error: 'missed its slot' })
        .eq('id', post.id);
      skipped.push({ id: post.id, reason: 'stale' });
      continue;
    }

    // Claim it. The status guard makes this a compare-and-set: a second
    // concurrent run matches zero rows and moves on.
    const { data: claimed, error: claimErr } = await supa
      .from('social_posts')
      .update({ status: 'publishing', attempts: (post.attempts ?? 0) + 1 })
      .eq('id', post.id)
      .eq('status', 'queued')
      .select('id');

    if (claimErr || !claimed?.length) {
      skipped.push({ id: post.id, reason: 'claimed by a concurrent run' });
      continue;
    }

    try {
      // Upload the card first. If this fails we still post text-only —
      // a post without an image beats a missed slot.
      let mediaIds: string[] | undefined;
      if (post.media_url) {
        try {
          mediaIds = [await uploadMedia(post.media_url as string)];
        } catch (e: any) {
          skipped.push({ id: post.id, reason: `media upload failed, posting text-only: ${e?.message}` });
        }
      }

      const result = await postToX(post.body as string, {
        mediaIds,
        refTable: 'social_posts',
        refId: post.id,
      });

      // Evergreen posts go back in the pool instead of retiring. They
      // are the floor that keeps a dead fixture day from being silent,
      // and a pool that empties after six uses stops being a floor.
      // published_at becomes "last used", and the planner picks the
      // least-recently-used one, so rotation is automatic.
      const isEvergreen = post.kind === 'evergreen';

      await supa
        .from('social_posts')
        .update({
          status: isEvergreen ? 'queued' : 'published',
          scheduled_at: isEvergreen ? null : post.scheduled_at,
          attempts: isEvergreen ? 0 : (post.attempts ?? 0) + 1,
          provider_post_id: result.id,
          published_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', post.id);

      published.push({ id: post.id, postId: result.id });
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      // A budget refusal is not this post's fault and will refuse every
      // other post too. Put it back and stop the run.
      if (msg.startsWith('budget:')) {
        await supa
          .from('social_posts')
          .update({ status: 'queued', attempts: post.attempts ?? 0, last_error: msg })
          .eq('id', post.id);
        budgetHalt = msg;
        break;
      }

      // 429 is a rate limit, not a bad post — requeue without burning
      // the attempt so it retries on the next tick.
      const isRateLimit = e instanceof XApiError && e.status === 429;
      await supa
        .from('social_posts')
        .update({
          status: 'queued',
          attempts: isRateLimit ? (post.attempts ?? 0) : (post.attempts ?? 0) + 1,
          last_error: msg.slice(0, 500),
        })
        .eq('id', post.id);

      failed.push({ id: post.id, error: msg.slice(0, 200) });
    }
  }

  // Anything that burned all three attempts is dead — mark it so the
  // queue query stops reconsidering it and the digest can surface it.
  await supa
    .from('social_posts')
    .update({ status: 'failed' })
    .eq('status', 'queued')
    .gte('attempts', 3);

  const budget = await budgetSummary().catch(() => null);

  if (budgetHalt) {
    await notify(
      `<b>X budget exhausted</b>\nPublishing paused for the rest of the month.\n\n${budgetHalt}\n\n` +
      `Raise SOCIAL_MONTHLY_BUDGET_USD or wait for the reset.`,
    ).catch(() => {});
  } else if (failed.length) {
    await notify(
      `<b>Publish failures</b>\n${failed.map((f) => `· #${f.id}: ${f.error}`).join('\n').slice(0, 800)}`,
    ).catch(() => {});
  }

  return NextResponse.json({
    published: published.length,
    details: published,
    skipped,
    failed,
    budgetHalt,
    budget,
  });
}
