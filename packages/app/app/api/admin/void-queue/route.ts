import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET  /api/admin/void-queue            — list markets awaiting a void decision
// POST /api/admin/void-queue            — { marketId, action: 'approve' | 'reject' }
//
// The resolve route no longer voids a market outright when it finds zero
// active bets — it marks it 'pending_void' and waits here. That's a
// deliberate speed bump: an empty-looking market could be genuinely
// empty, OR it could mean bet placement silently failed to record real
// stakes, in which case an instant auto-void would destroy them with no
// human ever noticing. This endpoint surfaces independent corroborating
// signals (treasury_log / points_log rows tied to the market, which are
// written in the SAME transaction as a successful bet insert) so an
// admin can tell the two cases apart before approving.
//
//   approve — finalizes the void: status → 'voided', resolved_outcome
//             cleared. Nothing to refund (there were no bet rows).
//   reject  — puts the market back to 'locked' with a clean slate
//             (resolved_outcome cleared) so it can be investigated and
//             resolved normally once whatever caused the empty bet list
//             is understood.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: pending, error } = await supabaseAdmin
    .from('markets')
    .select('id, question, status, resolved_outcome, resolved_outcomes, void_reason, void_requested_at, closes_at, is_locked_odds')
    .eq('status', 'pending_void')
    .order('void_requested_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const entries = [];
  for (const m of pending || []) {
    const [{ count: activeBets }, { count: anyBets }, { count: activeLegs }, { count: rakeRows }, { count: tierRoutingRows }, { data: duplicates }] = await Promise.all([
      supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('status', 'active'),
      supabaseAdmin.from('user_bets').select('id', { count: 'exact', head: true }).eq('market_id', m.id),
      supabaseAdmin.from('multiplier_legs').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('status', 'active'),
      supabaseAdmin.from('treasury_log').select('id', { count: 'exact', head: true }).eq('market_id', m.id).eq('type', 'entry_rake'),
      supabaseAdmin.from('tier_routing_log').select('id', { count: 'exact', head: true }).eq('market_id', m.id),
      // Duplicate-market check: the AI generator's own-fixture dedup only
      // runs for parent markets with a fixture_id — every AI-generated
      // prop market has neither, so nothing stops the same question
      // being created twice as separate rows. If that happened, real
      // bets could be sitting on the OTHER row while this one looks
      // empty and gets flagged for void.
      supabaseAdmin.from('markets').select('id, status').eq('question', m.question).neq('id', m.id),
    ]);

    // entry_rake / tier_routing_log rows are written in the SAME
    // transaction as a successful bet insert (place_bet/place_bet_locked).
    // If either has rows but user_bets is genuinely empty, that's
    // independent evidence bets were placed and the row itself is
    // missing — approving this void would be wrong.
    const hasCorroboratingRows = (rakeRows ?? 0) > 0 || (tierRoutingRows ?? 0) > 0;
    const hasDuplicateQuestion = (duplicates?.length ?? 0) > 0;
    const suspicious = (anyBets ?? 0) === 0 && (hasCorroboratingRows || hasDuplicateQuestion);

    entries.push({
      marketId: m.id,
      question: m.question,
      isLockedOdds: m.is_locked_odds,
      voidReason: m.void_reason,
      voidRequestedAt: m.void_requested_at,
      attemptedOutcome: m.resolved_outcome,
      attemptedOutcomes: m.resolved_outcomes,
      closesAt: m.closes_at,
      activeBets: activeBets ?? 0,
      totalBetRows: anyBets ?? 0,
      activeLegs: activeLegs ?? 0,
      corroboratingTreasuryRows: rakeRows ?? 0,
      corroboratingTierRoutingRows: tierRoutingRows ?? 0,
      duplicateMarketIds: (duplicates || []).map(d => ({ id: d.id, status: d.status })),
      suspicious,
      recommendation: suspicious
        ? hasDuplicateQuestion
          ? `DO NOT APPROVE — another market row exists with the exact same question: ${(duplicates || []).map(d => `#${d.id} (${d.status})`).join(', ')}. Bets were very likely placed against that row instead of this one — check it before voiding this one.`
          : 'DO NOT APPROVE without investigating — treasury/tier-routing rows exist for this market but user_bets does not. Bets were very likely placed and the row is missing.'
        : 'No corroborating evidence of bets on this market. Void appears safe to approve.',
    });
  }

  return NextResponse.json({ pendingCount: entries.length, entries });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const marketId = Number(body?.marketId);
  const action = body?.action;
  if (!marketId || !['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: "Provide marketId and action: 'approve' | 'reject'" }, { status: 400 });
  }

  const { data: market, error: mErr } = await supabaseAdmin
    .from('markets')
    .select('id, status')
    .eq('id', marketId)
    .single();
  if (mErr || !market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (market.status !== 'pending_void') {
    return NextResponse.json({ error: `Market ${marketId} is not pending_void (status=${market.status})` }, { status: 400 });
  }

  if (action === 'approve') {
    await supabaseAdmin.from('markets').update({
      status: 'voided',
      resolved_outcome: null,
      resolved_outcomes: null,
    }).eq('id', marketId);
    return NextResponse.json({ success: true, marketId, status: 'voided' });
  }

  // reject — back to 'locked' with a clean slate for a normal re-resolve.
  await supabaseAdmin.from('markets').update({
    status: 'locked',
    resolved_outcome: null,
    resolved_outcomes: null,
    void_reason: null,
    void_requested_at: null,
  }).eq('id', marketId);
  return NextResponse.json({ success: true, marketId, status: 'locked' });
}
