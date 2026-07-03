import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/mechanic/investigate-duplicate?marketId=1564
//
// Read-only. For the voided_empty_duplicate fingerprint: market X was
// voided as "no bets", but another market row has the exact same
// question text. Two ways this resolves:
//   - the duplicate legitimately absorbed the real bets and already
//     paid out correctly → X being empty-voided is just database noise
//     from an accidental double-create, nothing to fix
//   - X itself should have had bets and got wrongly voided (the
//     original placement bug from the incident) → needs a real
//     outcome and a re-resolve on X specifically
//
// This can't be decided algorithmically — it's a judgment call — so
// this endpoint just assembles everything an admin needs to decide in
// one screen instead of three separate SQL queries: both markets' full
// row, their bet/leg counts by status, and their options (so the UI
// can offer an outcome picker for X without a second round-trip).
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const marketId = Number(url.searchParams.get('marketId'));
  if (!marketId) return NextResponse.json({ error: 'Provide marketId' }, { status: 400 });

  const { data: primary, error: pErr } = await supabaseAdmin
    .from('markets')
    .select('id, question, status, options, resolved_outcome, resolved_outcomes, closes_at, resolved_at, is_locked_odds')
    .eq('id', marketId)
    .maybeSingle();
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
  if (!primary) return NextResponse.json({ error: `Market ${marketId} not found` }, { status: 404 });

  const { data: dupes, error: dErr } = await supabaseAdmin
    .from('markets')
    .select('id, question, status, options, resolved_outcome, resolved_outcomes, closes_at, resolved_at, is_locked_odds')
    .eq('question', primary.question)
    .neq('id', marketId);
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });

  const allMarketIds = [primary.id, ...(dupes || []).map(d => d.id)];
  const statCounts = async (mid: number) => {
    const [{ count: won }, { count: lost }, { count: active }, { count: refunded }, { count: legs }] = await Promise.all([
      supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', mid).eq('status', 'won'),
      supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', mid).eq('status', 'lost'),
      supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', mid).eq('status', 'active'),
      supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', mid).eq('status', 'refunded'),
      supabaseAdmin.from('multiplier_legs').select('id', { count: 'exact', head: true }).eq('market_id', mid),
    ]);
    return { won: won ?? 0, lost: lost ?? 0, active: active ?? 0, refunded: refunded ?? 0, legs: legs ?? 0 };
  };

  const [primaryStats, ...dupeStats] = await Promise.all(allMarketIds.map(statCounts));

  const dupesWithStats = (dupes || []).map((d, i) => ({ ...d, stats: dupeStats[i] }));
  const dupeHasRealActivity = dupesWithStats.some(d => d.stats.won + d.stats.lost + d.stats.active + d.stats.refunded + d.stats.legs > 0);
  const primaryHasActivity = primaryStats.won + primaryStats.lost + primaryStats.active + primaryStats.refunded + primaryStats.legs > 0;

  let recommendation: string;
  if (primaryHasActivity) {
    recommendation = `Market #${marketId} actually HAS bet activity (${JSON.stringify(primaryStats)}) despite being flagged empty-voided — this scan result may be stale, re-scan and check again before acting.`;
  } else if (dupeHasRealActivity) {
    recommendation = `The duplicate row has real bet activity and market #${marketId} genuinely has none — this looks like a harmless duplicate-create. No action needed; safe to dismiss.`;
  } else {
    recommendation = `Neither row has any bet activity. Likely both are genuinely empty (duplicate created but nobody bet on either). Safe to dismiss — nothing to recover.`;
  }

  return NextResponse.json({
    primary: { ...primary, stats: primaryStats },
    duplicates: dupesWithStats,
    recommendation,
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
  });
}
