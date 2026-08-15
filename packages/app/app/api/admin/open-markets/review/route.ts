import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/open-markets/review
// Body: { marketId, decision: 'approve'|'revise'|'reject', scores{}, hardGate?,
//         notes?, tier?, tradingClosesAt?, horizonAt?, disputeWindowHours? }
//
// The rubric lives in review_open_market, not here. This route's job is to
// establish WHO is reviewing and hand the decision to the database — every
// money-relevant check (score floor, hard gate, exposure cap, four eyes,
// untouched book, trading cut-off) happens under the market row lock, because
// a check in application code is a check two concurrent admins can both pass.
//
// Identity caveat, stated plainly: admin auth on this platform is a SHARED
// secret with no per-admin identity, so the reviewer id has to be supplied.
// A signed-in Supabase session is used when present because that is real
// identity; ADMIN_REVIEWER_USER_ID is the fallback for cookie-only sessions.
// This makes "the creator approved their own market" impossible by accident,
// which is the case that actually happens — it is not a defence against an
// admin who deliberately supplies someone else's id. Fixing that properly
// means per-admin accounts, which is a broader change than this engine.

const SCORE_DIMENSIONS = [
  'resolution_clarity', 'source_quality', 'horizon_realism',
  'ambiguity_resistance', 'audience_interest', 'category_fit',
] as const;

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const marketId = String(body?.marketId || '');
  const decision = String(body?.decision || '');
  if (!marketId) return NextResponse.json({ error: 'Missing marketId' }, { status: 400 });
  if (!['approve', 'revise', 'reject'].includes(decision)) {
    return NextResponse.json({ error: 'decision must be approve, revise or reject' }, { status: 400 });
  }

  // Real identity if there is a session; explicit config otherwise.
  const sessionUser = await getAuthUser(supabaseAdmin, request);
  const reviewerId = sessionUser?.id
    || String(body?.reviewerId || '')
    || process.env.ADMIN_REVIEWER_USER_ID
    || '';
  if (!reviewerId) {
    return NextResponse.json({
      error: 'No reviewer identity. Sign in, or set ADMIN_REVIEWER_USER_ID.',
    }, { status: 400 });
  }

  // Sum the rubric here so the total can never disagree with its parts — a
  // hand-typed total is how a 6 gets recorded as an 11.
  const raw = (body?.scores || {}) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  let total = 0;
  let scored = 0;
  for (const dim of SCORE_DIMENSIONS) {
    const v = raw[dim];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 2) {
      return NextResponse.json({ error: `${dim} must be 0, 1 or 2` }, { status: 400 });
    }
    scores[dim] = n; total += n; scored++;
  }
  // A partial scorecard cannot be approved: the missing dimensions are exactly
  // the ones nobody looked at.
  if (decision === 'approve' && scored < SCORE_DIMENSIONS.length) {
    return NextResponse.json({ error: 'Score all six dimensions before approving' }, { status: 400 });
  }

  const hardGate = String(body?.hardGate || '').trim() || null;
  const notes = String(body?.notes || '').trim() || null;

  const { data, error } = await supabaseAdmin.rpc('review_open_market', {
    p_market_id: marketId,
    p_reviewer_id: reviewerId,
    p_decision: decision,
    p_score: scored ? total : null,
    p_scores: scored ? scores : null,
    p_hard_gate: hardGate,
    p_notes: notes,
    p_tier: body?.tier ? String(body.tier) : null,
    p_trading_closes_at: body?.tradingClosesAt || null,
    p_horizon_at: body?.horizonAt || null,
    p_dispute_window_hours: body?.disputeWindowHours ?? null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    // Refusals come back as a reason, not an exception — they are decisions
    // the reviewer needs to read, not server faults.
    return NextResponse.json({ error: row?.reason || 'Could not apply', detail: row }, { status: 400 });
  }

  return NextResponse.json({
    applied: true,
    status: row.new_status,
    scoreTotal: scored ? total : null,
    bTngn: row.b_tngn === null ? null : Number(row.b_tngn),
    thresholdTngn: row.threshold_tngn === null ? null : Number(row.threshold_tngn),
    worstCaseTngn: row.worst_case_tngn === null ? null : Number(row.worst_case_tngn),
  });
}
