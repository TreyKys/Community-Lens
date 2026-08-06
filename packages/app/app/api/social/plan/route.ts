import { NextResponse } from 'next/server';
import { safeSecretMatch } from '@/lib/safeCompare';
import { getSupabaseAdmin, getBaseUrl } from '@/lib/oracle';
import { composeMarketPost, openMarkets, type PostKind } from '@/lib/social/compose';
import { budgetSummary } from '@/lib/social/budget';
import { notify } from '@/lib/social/telegram';
import { getSettings } from '@/lib/social/settings';

// POST /api/social/plan
//
// Runs once a day. Picks the markets worth talking about, drafts a post
// for each, and queues them at the hours Nigerian X is actually awake.
//
// Nothing here touches the X API — planning is free. The only spend is
// Gemini, which is a separate (and much cheaper) budget. That
// separation is deliberate: if the X budget is exhausted we still want
// the queue built, so the moment the month rolls over we are publishing
// again with no manual step.

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Posting slots, in UTC, chosen for WAT (UTC+1):
 *   07:00 UTC = 08:00 WAT — morning commute
 *   12:00 UTC = 13:00 WAT — lunch
 *   17:00 UTC = 18:00 WAT — close of work, pre-kickoff for most fixtures
 *   20:00 UTC = 21:00 WAT — peak evening scroll
 *
 * Four slots, not ten. An account this size posting ten times a day is
 * posting into a void and shedding the followers it does have — reach
 * comes from replies, not from volume on the brand account.
 */
const SLOTS_UTC = [7, 12, 17, 20];

/**
 * Posts to queue today.
 *
 * The database override wins over the env var, so /cap from Telegram
 * takes effect on the next run without a deploy. Zero is a legitimate
 * value — "queue nothing" — so it is distinguished from "unset" rather
 * than falling through a truthiness check.
 */
function dailyCap(override: number | null): number {
  if (override !== null && Number.isFinite(override) && override >= 0) {
    return Math.min(override, SLOTS_UTC.length);
  }
  const n = Number(process.env.SOCIAL_DAILY_POST_CAP);
  return Number.isFinite(n) && n > 0 ? Math.min(n, SLOTS_UTC.length) : SLOTS_UTC.length;
}

/** Next occurrence of an hour, today if it is still ahead of us. */
function slotTime(hourUtc: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0,
  ));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!safeSecretMatch(cronSecret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supa = getSupabaseAdmin();
  const settings = await getSettings();
  const cap = dailyCap(settings.dailyPostCap);
  const planned: Array<{ marketId: string; kind: PostKind; at: string }> = [];
  const errors: string[] = [];

  // Nothing to plan, and no Gemini calls to pay for. Returning early
  // also stops the "queued 0" alert below from firing every morning
  // while deliberately capped at zero.
  if (cap === 0) {
    return NextResponse.json({ planned: 0, slots: [], errors: [], cappedAtZero: true });
  }

  try {
    const markets = await openMarkets(40);

    // Rank by how soon they close. A market closing in six hours is a
    // better post than one closing in six days — urgency is the hook,
    // and it also means the post cannot go stale before it publishes.
    const candidates = markets
      .filter((m) => Array.isArray(m.options) && m.options.length >= 2)
      .slice(0, cap * 3);

    // Which markets already have a queued or published post of a given
    // kind. The unique index would reject a duplicate anyway, but
    // checking first saves a wasted Gemini call per collision.
    const { data: existing } = await supa
      .from('social_posts')
      .select('source_market_id, kind')
      .in('source_market_id', candidates.map((m) => m.id))
      .neq('status', 'cancelled');

    const taken = new Set((existing ?? []).map((r: any) => `${r.source_market_id}:${r.kind}`));

    let slotIndex = 0;
    for (const m of candidates) {
      if (slotIndex >= cap) break;

      // A market with real money on it gets a movement post; a fresh
      // one gets its opening line.
      const hasPool = Object.values(m.pool_by_outcome ?? {}).some((v) => Number(v) > 0);
      const kind: PostKind = hasPool ? 'movement' : 'opening_line';

      if (taken.has(`${m.id}:${kind}`)) continue;

      const body = await composeMarketPost(m, kind);
      if (!body) {
        errors.push(`compose failed or non-compliant for market ${m.id}`);
        continue;
      }

      const scheduledAt = slotTime(SLOTS_UTC[slotIndex]);

      const { error } = await supa.from('social_posts').insert({
        channel: 'x',
        kind,
        body,
        // Rendered on demand from live pool data at publish time — so
        // the image can never quote a split that has since moved.
        media_url: `${getBaseUrl()}/api/social/card/${m.id}`,
        source_market_id: m.id,
        scheduled_at: scheduledAt.toISOString(),
        priority: 100,
      });

      if (error) {
        // 23505 is the dedupe index doing its job on a concurrent run.
        if (!String(error.code).startsWith('23505')) {
          errors.push(`queue insert failed for ${m.id}: ${error.message}`);
        }
        continue;
      }

      planned.push({ marketId: String(m.id), kind, at: scheduledAt.toISOString() });
      slotIndex++;
    }

    // Backfill from the evergreen pool so a dead fixture day still
    // posts. These are hand-written and reusable, which is the ONLY
    // place pre-written content belongs — as a floor, not the engine.
    if (planned.length < cap) {
      const need = cap - planned.length;
      const { data: evergreen } = await supa
        .from('social_posts')
        .select('id')
        .eq('kind', 'evergreen')
        .eq('status', 'queued')
        .is('scheduled_at', null)
        // Least-recently-used first. Never-published rows (null) come
        // first, so the pool cycles rather than replaying a favourite.
        .order('published_at', { ascending: true, nullsFirst: true })
        .limit(need);

      for (let i = 0; i < (evergreen ?? []).length; i++) {
        const at = slotTime(SLOTS_UTC[planned.length + i]);
        await supa
          .from('social_posts')
          .update({ scheduled_at: at.toISOString() })
          .eq('id', (evergreen as any[])[i].id);
        planned.push({ marketId: 'evergreen', kind: 'evergreen', at: at.toISOString() });
      }
    }
  } catch (e: any) {
    errors.push(e?.message ?? String(e));
  }

  const budget = await budgetSummary().catch(() => null);

  // Only buzz the phone when something needs a person. A clean run is
  // silent — a notification that fires every day gets muted, and then
  // the one that mattered gets muted with it.
  if (errors.length || planned.length === 0) {
    await notify(
      `<b>Social planner</b>\nQueued: ${planned.length}\n` +
      (budget ? `Budget: $${budget.spentUsd.toFixed(2)}/$${budget.capUsd.toFixed(2)} (${budget.pctUsed}%)\n` : '') +
      (errors.length ? `\nIssues:\n${errors.slice(0, 5).map((e) => `· ${e}`).join('\n')}` : ''),
    ).catch(() => {});
  }

  return NextResponse.json({ planned: planned.length, slots: planned, errors, budget });
}
