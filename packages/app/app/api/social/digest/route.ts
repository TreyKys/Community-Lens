import { NextResponse } from 'next/server';
import { safeSecretMatch } from '@/lib/safeCompare';
import { getSupabaseAdmin } from '@/lib/oracle';
import { composeMarketPost, openMarkets, type PostKind } from '@/lib/social/compose';
import { draftFromBrief } from '@/lib/social/brief';
import { makeReadyPost } from '@/lib/social/ready';
import { notify } from '@/lib/social/telegram';
import { getSettings } from '@/lib/social/settings';
import { DIGEST_TOPICS, MARKET_POSTS_PER_RUN } from '@/lib/social/topics';

// POST /api/social/digest
//
// Runs four times a day (07:00 / 12:00 / 17:00 / 20:00 UTC — the old
// posting slots, now used as review bursts instead of publish times).
// Writes posts about a fixed set of topics plus whatever markets are
// worth talking about, and pushes each one straight to Telegram as a
// ready-to-post card: photo, caption, Posted / Own image / Discard.
//
// THIS REPLACES SCHEDULED AUTO-PUBLISHING, not just the planner. There
// is no queue, no scheduled_at, no X API call anywhere in this file.
// The operator posts every one of these themselves — from the X app,
// in their own voice, at their own pace — which is also what makes the
// whole pipeline free: nothing here spends X's metered API, so there
// is nothing to budget and nothing that needs developer keys to run.
//
// The old scheduled path (cron-social-plan.yml -> this route's
// predecessor -> cron-social-publish.yml -> the X API) still exists,
// still works, and is deliberately left in place — see
// cron-social-plan.yml for why its schedule is now disabled instead of
// deleted. If X posting is ever worth automating again, that path is
// still there to switch back on.

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Undecided drafts older than this are retired. BBN gossip from
 * yesterday's 07:00 burst is not worth reviewing at today's 07:00. */
const DRAFT_EXPIRY_HOURS = 24;

type Counts = Record<string, number>;

function summarise(counts: Counts, total: number): string {
  if (total === 0) return `<b>Nothing ready this round.</b>`;
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} x${n}`)
    .join(' · ');
  return (
    `🗞 <b>${total} post${total === 1 ? '' : 's'} ready</b>\n${parts}\n\n` +
    `Tap <b>Posted</b> once you've shared one, or <b>Discard</b> to skip it.`
  );
}

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!safeSecretMatch(cronSecret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // /pause stops the whole pipeline, not just X publishing — the
  // operator's phone should go quiet the moment they ask it to,
  // without needing to know this route exists separately from the old
  // publish cron. Checked before anything is generated, so a pause
  // costs nothing rather than generating a burst nobody asked to see.
  const settings = await getSettings();
  if (settings.publishingPaused) {
    return NextResponse.json({ generated: 0, paused: true, reason: settings.pausedReason });
  }

  const supa = getSupabaseAdmin();

  // Retire drafts nobody decided on. At four bursts a day this matters
  // more than it did at one a day: without it, a skipped review leaves
  // three bursts' worth of stale cards sitting in the chat by evening.
  await supa
    .from('social_posts')
    .update({ status: 'cancelled', last_error: 'draft expired unreviewed' })
    .eq('status', 'draft')
    .lt('created_at', new Date(Date.now() - DRAFT_EXPIRY_HOURS * 3600 * 1000).toISOString());

  const counts: Counts = {};
  const errors: string[] = [];
  let total = 0;

  // ── the fixed topics ────────────────────────────────────────────
  for (const topic of DIGEST_TOPICS) {
    counts[topic.label] = 0;
    try {
      const result = await draftFromBrief({ brief: topic.brief, count: topic.countPerRun });

      for (const body of result.drafts) {
        const id = await makeReadyPost({
          body,
          kind: 'briefed',
          brief: topic.brief,
          kicker: topic.label,
        });
        if (id) {
          counts[topic.label]++;
          total++;
        }
      }

      if (!result.drafts.length) {
        errors.push(`${topic.label}: nothing usable came back`);
      } else if (result.rejected.length) {
        errors.push(`${topic.label}: ${result.rejected.length} dropped by a compliance guard`);
      }
    } catch (e: any) {
      errors.push(`${topic.label}: ${String(e?.message ?? e).slice(0, 150)}`);
    }
  }

  // ── the site's own markets ──────────────────────────────────────
  counts['Markets'] = 0;
  try {
    const markets = await openMarkets(40);
    const candidates = markets.filter((m) => Array.isArray(m.options) && m.options.length >= 2);

    const { data: existing } = await supa
      .from('social_posts')
      .select('source_market_id, kind')
      .in('source_market_id', candidates.map((m) => m.id))
      .neq('status', 'cancelled');
    const taken = new Set((existing ?? []).map((r: any) => `${r.source_market_id}:${r.kind}`));

    for (const m of candidates) {
      if (counts['Markets'] >= MARKET_POSTS_PER_RUN) break;

      const hasPool = Object.values(m.pool_by_outcome ?? {}).some((v) => Number(v) > 0);
      const kind: PostKind = hasPool ? 'movement' : 'opening_line';
      if (taken.has(`${m.id}:${kind}`)) continue;

      const body = await composeMarketPost(m, kind);
      if (!body) continue;

      const id = await makeReadyPost({ body, kind, sourceMarketId: m.id });
      if (id) {
        counts['Markets']++;
        total++;
      }
    }
  } catch (e: any) {
    errors.push(`Markets: ${String(e?.message ?? e).slice(0, 150)}`);
  }

  // The whole point is the notification — unlike the old planner this
  // fires every run, success or not, because a burst with nothing to
  // show is itself worth knowing about.
  await notify(
    summarise(counts, total) +
    (errors.length ? `\n\n<i>${errors.map((e) => escapeHtml(e)).join(' · ')}</i>` : ''),
  ).catch(() => {});

  return NextResponse.json({ generated: total, counts, errors });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
