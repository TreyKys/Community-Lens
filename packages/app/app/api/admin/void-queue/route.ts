import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

// Never cache the queue — an admin re-opens the tab expecting to see
// what's actually pending right now, not a snapshot from 30s ago.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Surrogate-Control': 'no-store',
};

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

  return NextResponse.json({ pendingCount: entries.length, entries }, { headers: NO_CACHE });
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
  const reason = typeof body?.reason === 'string' ? body.reason : null;
  const validActions = ['approve', 'reject', 'force_void'];
  if (!marketId || !validActions.includes(action)) {
    return NextResponse.json({ error: `Provide marketId and action: one of ${validActions.join(', ')}` }, { status: 400 });
  }

  const { data: market, error: mErr } = await supabaseAdmin
    .from('markets')
    .select('id, status, question')
    .eq('id', marketId)
    .single();
  if (mErr || !market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  if (action === 'approve') {
    if (market.status !== 'pending_void') {
      return NextResponse.json({ error: `Market ${marketId} is not pending_void (status=${market.status})` }, { status: 400 });
    }
    await supabaseAdmin.from('markets').update({
      status: 'voided',
      resolved_outcome: null,
      resolved_outcomes: null,
    }).eq('id', marketId);
    return NextResponse.json({ success: true, marketId, status: 'voided' }, { headers: NO_CACHE });
  }

  if (action === 'reject') {
    if (market.status !== 'pending_void') {
      return NextResponse.json({ error: `Market ${marketId} is not pending_void (status=${market.status})` }, { status: 400 });
    }
    await supabaseAdmin.from('markets').update({
      status: 'locked',
      resolved_outcome: null,
      resolved_outcomes: null,
      void_reason: null,
      void_requested_at: null,
    }).eq('id', marketId);
    return NextResponse.json({ success: true, marketId, status: 'locked' }, { headers: NO_CACHE });
  }

  // ── force_void ──────────────────────────────────────────────────────
  // Admin explicitly wants this market gone regardless of its current
  // state. Refund every ACTIVE single-bet stake (to bonus_balance so a
  // mistaken force-void is still clawable — same convention the recoup
  // tools use) and set every ACTIVE multiplier leg to 'void' so the
  // parent slip's counters advance naturally on its next settle pass.
  // Won/lost/refunded bets and already-settled slips are NOT touched —
  // this is only for pre-settlement voiding, not undoing past
  // settlements. For that, see /api/admin/re-resolve-voided-market.
  if (market.status === 'voided' || market.status === 'resolved') {
    return NextResponse.json({
      error: `Market ${marketId} is already ${market.status} — force_void here only handles pre-settlement voiding. Use /api/admin/re-resolve-voided-market to undo a wrongful past settlement.`,
    }, { status: 400 });
  }

  const { data: activeBets, error: abErr } = await supabaseAdmin
    .from('user_bets')
    .select('id, user_id, net_stake_tngn, bonus_proportion')
    .eq('market_id', marketId)
    .eq('status', 'active');
  if (abErr) return NextResponse.json({ error: abErr.message }, { status: 500 });

  let betsRefunded = 0;
  let totalRefundTngn = 0;
  for (const b of activeBets || []) {
    const netStake = Number(b.net_stake_tngn || 0);
    const bonusProp = Number(b.bonus_proportion || 0);
    // Refund proportionally to funding source — cash portion back to
    // tngn, bonus portion back to bonus.
    const tngnBack = Math.round(netStake * (1 - bonusProp) * 10000) / 10000;
    const bonusBack = netStake - tngnBack;
    if (netStake > 0) {
      const { error: cErr } = await supabaseAdmin.rpc('credit_user', {
        p_user_id: b.user_id,
        p_tngn_delta: tngnBack,
        p_bonus_delta: bonusBack,
      });
      if (cErr) return NextResponse.json({ error: `credit_user for bet ${b.id}: ${cErr.message}` }, { status: 500 });
      totalRefundTngn += netStake;
    }
    await supabaseAdmin.from('user_bets').update({
      status: 'refunded',
      payout_tngn: netStake,
    }).eq('id', b.id);
    betsRefunded += 1;
  }

  // Multiplier legs — mark active legs on this market as void; the
  // next call to settle_multiplier_for_market for this market (or a
  // parent slip finalization) will advance the counters and either
  // pay the slip or refund it on the all-void path.
  try {
    await supabaseAdmin.rpc('settle_multiplier_for_market', {
      p_market_id: marketId,
      p_winning_outcomes: null,
      p_voided: true,
    });
  } catch (e) {
    console.error(`force_void: settle_multiplier_for_market failed for market ${marketId}:`, e);
  }

  await supabaseAdmin.from('markets').update({
    status: 'voided',
    resolved_outcome: null,
    resolved_outcomes: null,
    void_reason: reason || 'admin_force_void',
    void_requested_at: new Date().toISOString(),
  }).eq('id', marketId);

  await supabaseAdmin.from('treasury_log').insert({
    type: 'admin_force_void',
    amount_tngn: -totalRefundTngn,
    market_id: marketId,
    metadata: {
      reason: reason || null,
      bets_refunded: betsRefunded,
      total_refund_tngn: totalRefundTngn,
    },
    created_at: new Date().toISOString(),
  });

  return NextResponse.json({
    success: true,
    marketId,
    status: 'voided',
    betsRefunded,
    totalRefundTngn,
    note: 'Force-voided. Active single bets refunded proportional to their funding source; active multiplier legs marked void so parent slips advance on their next settle pass. No effect on already-settled bets or slips — for those, use re-resolve-voided-market.',
  }, { headers: NO_CACHE });
}
