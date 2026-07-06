import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

// Long-running admin scan — has to fit in one serverless invocation.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/diagnose-recent-resolutions?sinceHours=48
//
// Read-only. Scans every market touched in the window (resolved/voided
// recently, OR still locked well past its closes_at) and reports bet
// and Multiplier-leg status counts per market, flagging anomalies:
//
//   orphaned_bets   — market is resolved/voided but user_bets rows on
//                     it are still status='active' (settlement never
//                     reached them; NOT the same fingerprint as
//                     repair-stuck-resolutions, which only catches a
//                     market still stuck at status='locked' — this
//                     catches the case where the MARKET finished but
//                     specific BET rows didn't).
//   orphaned_legs   — same, for multiplier_legs (what
//                     repair-multiplier-legs fixes).
//   stuck_claimed   — status='locked' with resolved_outcome already
//                     set (the repair-stuck-resolutions fingerprint).
//   never_resolved  — status='locked', resolved_outcome still null,
//                     well past closes_at — resolve was never even
//                     attempted or the cron/oracle lookup keeps failing.
//   voided_with_outcome — status='voided' AND resolved_outcome is not
//                     null — the historical wrongful-refund fingerprint
//                     (what recoup-refunds targets).
//   voided_empty_duplicate — status='voided' with no bets recorded
//                     (the old auto-void-on-empty fingerprint, from
//                     before that path required admin approval) AND
//                     another market row exists with the exact same
//                     question. If real bets landed on that OTHER row,
//                     this one was voided wrongly — check the duplicate
//                     before assuming the void was correct.
//
// This is diagnostic only — it changes nothing. Once a market shows up
// here with a flag, use the matching repair tool (or recoup-refunds)
// on that specific marketId.
export async function GET(request: Request) {
  try {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const sinceHours = Number(url.searchParams.get('sinceHours')) || 48;
  // Optional cap so a very wide window doesn't time out the serverless
  // invocation. Default 100; pass ?limit=250 (or higher) if you need
  // more.
  const perStatusLimit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  // Candidate markets: anything resolved/voided recently, OR anything
  // still locked that closed more than 2 hours ago (should have
  // resolved by now one way or another).
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const [{ data: recentlyTouched, error: e1 }, { data: stillLocked, error: e2 }] = await Promise.all([
    supabaseAdmin
      .from('markets')
      .select('id, question, status, resolved_outcome, resolved_outcomes, resolved_at, closes_at, is_locked_odds')
      .in('status', ['resolved', 'voided'])
      .gte('resolved_at', sinceIso)
      .order('resolved_at', { ascending: false })
      .limit(perStatusLimit),
    supabaseAdmin
      .from('markets')
      .select('id, question, status, resolved_outcome, resolved_outcomes, resolved_at, closes_at, is_locked_odds')
      .eq('status', 'locked')
      .lt('closes_at', twoHoursAgo)
      .order('closes_at', { ascending: false })
      .limit(perStatusLimit),
  ]);

  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

  const markets = [...(recentlyTouched || []), ...(stillLocked || [])];
  if (markets.length === 0) {
    return NextResponse.json({ marketsScanned: 0, flagged: [], note: 'Nothing touched in this window.' });
  }

  const flagged: any[] = [];
  const perMarketErrors: any[] = [];
  const summary = { orphaned_bets: 0, orphaned_legs: 0, stuck_claimed: 0, never_resolved: 0, voided_with_outcome: 0, voided_empty_duplicate: 0 };

  for (const m of markets) {
    try {
      const [betsRes, legsRes, wonRes, lostRes, totalRes] = await Promise.all([
        supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('status', 'active'),
        supabaseAdmin.from('multiplier_legs').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('status', 'active'),
        supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('status', 'won'),
        supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('status', 'lost'),
        supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', m.id),
      ]);
      // Surface any per-query error explicitly instead of letting a
      // .count of undefined silently mask a permission or connection
      // failure.
      const firstErr = [betsRes, legsRes, wonRes, lostRes, totalRes].find(r => r.error);
      if (firstErr?.error) throw new Error(firstErr.error.message);

      const activeBets = betsRes.count ?? 0;
      const activeLegs = legsRes.count ?? 0;
      const wonBets = wonRes.count ?? 0;
      const lostBets = lostRes.count ?? 0;
      const totalBets = totalRes.count ?? 0;

      const flags: string[] = [];
      const isFinished = m.status === 'resolved' || m.status === 'voided';
      let duplicateMarketIds: { id: number; status: string }[] = [];

      if (isFinished && activeBets > 0) flags.push('orphaned_bets');
      if (isFinished && activeLegs > 0) flags.push('orphaned_legs');
      if (m.status === 'locked' && m.resolved_outcome !== null && m.resolved_outcome !== undefined) flags.push('stuck_claimed');
      if (m.status === 'locked' && (m.resolved_outcome === null || m.resolved_outcome === undefined)) flags.push('never_resolved');
      if (m.status === 'voided' && m.resolved_outcome !== null && m.resolved_outcome !== undefined) flags.push('voided_with_outcome');

      if (m.status === 'voided' && (m.resolved_outcome === null || m.resolved_outcome === undefined) && totalBets === 0 && m.question) {
        const { data: dupes, error: dupeErr } = await supabaseAdmin.from('markets').select('id, status').eq('question', m.question).neq('id', m.id);
        if (dupeErr) throw new Error(`duplicate check: ${dupeErr.message}`);
        if (dupes && dupes.length > 0) {
          duplicateMarketIds = dupes as any;
          flags.push('voided_empty_duplicate');
        }
      }

      if (flags.length === 0) continue;

      flags.forEach(f => { (summary as any)[f] = ((summary as any)[f] || 0) + 1; });

      flagged.push({
        marketId: m.id,
        question: m.question,
        status: m.status,
        isLockedOdds: m.is_locked_odds,
        resolvedOutcome: m.resolved_outcome,
        resolvedOutcomes: m.resolved_outcomes,
        resolvedAt: m.resolved_at,
        closesAt: m.closes_at,
        activeBets,
        activeLegs,
        wonBets,
        lostBets,
        totalBets,
        duplicateMarketIds,
        flags,
      });
    } catch (e: any) {
      perMarketErrors.push({ marketId: m.id, error: e?.message || String(e) });
    }
  }

  return NextResponse.json({
    windowHours: sinceHours,
    marketsScanned: markets.length,
    flaggedCount: flagged.length,
    summary,
    flagged,
    perMarketErrors,
    note: 'Diagnostic only — nothing changed. orphaned_bets/orphaned_legs need a targeted resolve/repair on that marketId; stuck_claimed → repair-stuck-resolutions; never_resolved → check /api/admin/diagnose-result?marketId=X for why the oracle lookup never resolved it; voided_with_outcome → recoup-refunds; voided_empty_duplicate → check duplicateMarketIds, real bets may be sitting on the other row.',
  });
  } catch (e: any) {
    console.error('diagnose-recent-resolutions crashed:', e);
    return NextResponse.json({ error: `Diagnostic failed: ${e?.message || String(e)}`, stack: (e?.stack || '').slice(0, 400) }, { status: 500 });
  }
}
