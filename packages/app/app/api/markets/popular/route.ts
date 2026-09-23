import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/markets/popular — "Popular Right Now" on the homepage rail.
//
// Previously PopularMarketsScroll queried `markets` directly, ordered by
// total_pool DESC. total_pool is a LIFETIME, monotonically-growing figure,
// and — same root cause as the Multiplier-void incident — Multiplier legs
// (most of the platform's real volume) never write to it at all. The result
// was structural, not a display glitch: a handful of markets that
// accumulated a pool once (2027 election props, open for months) sat
// permanently at the top, while a football market with real Multiplier
// activity TODAY showed total_pool=0 and could never break in. The rail
// looked frozen because, by the metric it sorted on, it effectively was.
//
// Fix: rank by RECENT activity — direct bets and Multiplier legs placed in
// the last 48h, spanning both engines — with total_pool only as a
// tiebreaker among markets with equal (often zero) recent activity. A
// market with genuine action today now outranks one that hasn't moved in
// months, and the rail actually changes as trading happens.
const ACTIVITY_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function GET() {
  const now = Date.now();
  const activityCutoff = new Date(now - ACTIVITY_WINDOW_MS).toISOString();
  // Same two staleness gates PopularMarketsScroll used to apply itself — see
  // that component's prior comment for why the closes_at floor also matters
  // for keeping pending_void markets out.
  const resolvedCutoff = new Date(now - 26 * 60 * 60 * 1000).toISOString();
  const staleCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [eligibleRes, recentBetsRes, recentLegsRes] = await Promise.all([
    supabaseAdmin
      .from('markets')
      .select('id, question, category, total_pool, closes_at, options, status')
      .or(`and(status.in.(open,locked),closes_at.gte.${staleCutoff}),and(status.eq.resolved,resolved_at.gte.${resolvedCutoff})`)
      .is('parent_market_id', null)
      // Ordered by id, not total_pool — this is the full eligible candidate
      // set the activity ranking below sorts, not a pre-filtered top slice
      // that would just reintroduce the same bias.
      .order('id', { ascending: false })
      .limit(300),
    supabaseAdmin.from('user_bets').select('market_id').gte('placed_at', activityCutoff).limit(5000),
    supabaseAdmin.from('multiplier_legs').select('market_id').gte('created_at', activityCutoff).limit(5000),
  ]);

  if (eligibleRes.error) {
    return NextResponse.json({ error: eligibleRes.error.message }, { status: 500 });
  }

  const activity = new Map<number, number>();
  for (const r of (recentBetsRes.data || []) as { market_id: number }[]) {
    activity.set(r.market_id, (activity.get(r.market_id) || 0) + 1);
  }
  for (const r of (recentLegsRes.data || []) as { market_id: number }[]) {
    activity.set(r.market_id, (activity.get(r.market_id) || 0) + 1);
  }

  const markets = (eligibleRes.data || [])
    .map(m => ({ market: m, hits: activity.get(m.id) || 0 }))
    .sort((a, b) => b.hits - a.hits || Number(b.market.total_pool) - Number(a.market.total_pool))
    .slice(0, 12)
    .map(({ market }) => market);

  return NextResponse.json({ markets }, { headers: { 'Cache-Control': 'no-store' } });
}
