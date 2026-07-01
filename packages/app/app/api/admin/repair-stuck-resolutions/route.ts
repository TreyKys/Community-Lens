import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getBaseUrl, cronHeaders } from '@/lib/oracle';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/repair-stuck-resolutions
//
// Finds markets that got CLAIMED by a resolve attempt (resolved_outcome
// set) but never finished (status is still 'locked' instead of
// 'resolved'/'voided') — the fingerprint of a resolve call that died
// mid-settlement (a credit_user/award_points/settle_multiplier_for_market
// RPC threw partway through the payout loop). Before the resumable-claim
// fix in /api/markets/resolve, this state was PERMANENT: every retry hit
// the same 409 "already in progress" and the still-active bets/legs on
// that market could never be paid or marked, no matter how many times
// you clicked Resolve.
//
// This tool just re-POSTs the market's own already-recorded outcome(s)
// back to /api/markets/resolve, which now resumes instead of rejecting.
// Idempotent and safe to run repeatedly: only status='active' bets/legs
// are ever touched, so nothing already settled gets re-processed or
// double-paid.
//
// dryRun defaults TRUE: lists the stuck markets + how many bets/legs are
// still active on each, without changing anything. Re-POST
// { dryRun: false } to actually resume them.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const dryRun = body?.dryRun !== false; // default TRUE
  const explicitIds: number[] | null = Array.isArray(body?.marketIds)
    ? body.marketIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
    : null;

  let q = supabaseAdmin
    .from('markets')
    .select('id, question, status, resolved_outcome, resolved_outcomes, resolved_at')
    .eq('status', 'locked')
    .not('resolved_outcome', 'is', null);
  if (explicitIds) q = q.in('id', explicitIds);

  const { data: stuck, error: mErr } = await q;
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  if (!stuck || stuck.length === 0) {
    return NextResponse.json({ dryRun, marketsStuck: 0, results: [], note: 'No stuck resolutions found.' });
  }

  const results: any[] = [];
  const baseUrl = getBaseUrl();

  for (const m of stuck) {
    const winningOutcomeIndices: number[] = Array.isArray(m.resolved_outcomes) && m.resolved_outcomes.length > 0
      ? m.resolved_outcomes
      : [m.resolved_outcome];

    const { count: activeBets } = await supabaseAdmin
      .from('user_bets')
      .select('id', { count: 'exact', head: true })
      .eq('market_id', m.id)
      .eq('status', 'active');
    const { count: activeLegs } = await supabaseAdmin
      .from('multiplier_legs')
      .select('id', { count: 'exact', head: true })
      .eq('market_id', m.id)
      .eq('status', 'active');

    const entry: any = {
      marketId: m.id,
      question: m.question,
      winningOutcomeIndices,
      claimedAt: m.resolved_at,
      activeBets: activeBets ?? 0,
      activeLegs: activeLegs ?? 0,
    };

    if (!dryRun) {
      try {
        const res = await fetch(`${baseUrl}/api/markets/resolve`, {
          method: 'POST',
          headers: cronHeaders(),
          body: JSON.stringify({ marketId: m.id, winningOutcomeIndices }),
        });
        entry.resumeResult = await res.json().catch(() => ({}));
        entry.resumed = res.ok;
      } catch (e: any) {
        entry.resumed = false;
        entry.error = e?.message || 'resume call failed';
      }
    }

    results.push(entry);
  }

  return NextResponse.json({
    dryRun,
    marketsStuck: results.length,
    results,
    note: dryRun
      ? 'DRY RUN — nothing changed. Re-POST { dryRun: false } (optionally { marketIds: [...] } to scope it) to resume these markets.'
      : 'Resume attempted for every stuck market. Check each entry’s resumeResult — a market can still come back partial (207) if it hits another failing row; re-run this tool again in that case.',
  });
}
