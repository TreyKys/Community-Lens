import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Slip-funding audit + repair for the bonus_proportion regression
// (migration 20260710010000 stamped bonus_proportion = 0 on slips placed
// while the bonus-unaware place_multiplier_slip was live).
//
// GET  — review report: candidate slips (proportion = 0 owned by a user
//        who has actually touched bonus, since a genuinely all-cash slip
//        is ALSO 0 and the two can't be told apart from stored data),
//        each with the funding CONTEXT an admin needs to ascertain the
//        source. NOTE: the exact funding split is NOT reconstructable —
//        no per-user balance snapshot is recorded at placement — so this
//        is decision-support, not a certainty.
//
// POST — apply the correction (treat as fully bonus-funded, proportion = 1.0,
//        the house-conservative default). Two mechanisms by slip status:
//          * ACTIVE  — nothing has moved yet, so just flip the recorded
//                      bonus_proportion; settlement later does the split.
//          * SETTLED (won / voided) — the money ALREADY paid out 100% to
//                      cash, so flipping the record alone would make it lie.
//                      We call reclaim_slip_bonus_split, which MOVES money:
//                      claws the over-paid cash back into bonus (atomic,
//                      idempotent, clamped to the wallet — if the user
//                      already withdrew it, the unrecoverable part is
//                      reported as `shortfall` and no bonus is fabricated).
//          * LOST    — moved no payout, so proportion has no monetary
//                      effect; skipped.
//        Supports dryRun and logs every correction to treasury_log.

const BONUS_GRANT_TYPES = ['welcome_match', 'admin_credit', 'weekly_rebate', 'bonus_grant', 'vip_referral_bonus', 'referral_signup_bonus'];

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // Optional ISO cutoff — roughly when the regressed migration went live.
  const since = searchParams.get('since');
  // Include already-settled slips in the report (for exposure accounting).
  // Default false: only ACTIVE slips, which are the ones still fixable.
  const includeSettled = searchParams.get('includeSettled') === 'true';

  // Users who have actually touched bonus: currently hold it, or were ever
  // granted it. A user who has NEVER had bonus could not have bonus-funded a
  // slip, so their proportion = 0 is genuinely correct and excluded.
  const { data: bonusHolders } = await supabaseAdmin
    .from('users')
    .select('id')
    .gt('bonus_balance', 0);
  const { data: bonusGranted } = await supabaseAdmin
    .from('treasury_log')
    .select('user_id')
    .in('type', BONUS_GRANT_TYPES);

  const bonusUserIds = new Set<string>();
  for (const u of bonusHolders || []) if (u.id) bonusUserIds.add(u.id as string);
  for (const g of bonusGranted || []) if (g.user_id) bonusUserIds.add(g.user_id as string);

  if (bonusUserIds.size === 0) {
    return NextResponse.json({ candidates: [], summary: { total: 0, active: 0, settled: 0, note: 'No users have touched bonus — no slips at risk.' } });
  }

  const statuses = includeSettled ? ['active', 'won', 'lost', 'voided'] : ['active'];
  let q = supabaseAdmin
    .from('multiplier_slips')
    .select('id, user_id, slip_stake_tngn, net_slip_stake_tngn, payout_tngn, final_payout_tngn, status, bonus_proportion, created_at')
    .in('user_id', Array.from(bonusUserIds))
    .in('status', statuses)
    .or('bonus_proportion.is.null,bonus_proportion.eq.0')
    .order('created_at', { ascending: true })
    .limit(500);
  if (since) q = q.gte('created_at', since);

  const { data: slips, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Per-user context to help ascertain funding, resolved in bulk.
  const userIds = Array.from(new Set((slips || []).map(s => s.user_id).filter(Boolean)));
  const contextByUser: Record<string, any> = {};
  if (userIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, username, first_name, tngn_balance, bonus_balance')
      .in('id', userIds);
    const { data: grants } = await supabaseAdmin
      .from('treasury_log')
      .select('user_id, amount_tngn, type')
      .in('user_id', userIds)
      .in('type', BONUS_GRANT_TYPES);
    const grantedByUser: Record<string, number> = {};
    for (const g of grants || []) {
      grantedByUser[g.user_id] = (grantedByUser[g.user_id] || 0) + Number(g.amount_tngn || 0);
    }
    for (const u of users || []) {
      contextByUser[u.id] = {
        handle: u.username || u.first_name || 'user',
        currentTngn: Number(u.tngn_balance || 0),
        currentBonus: Number(u.bonus_balance || 0),
        lifetimeBonusGranted: Math.round(grantedByUser[u.id] || 0),
      };
    }
  }

  const candidates = (slips || []).map(s => {
    const ctx = contextByUser[s.user_id] || {};
    const status = s.status;
    // A settled won/voided slip already paid out 100% to cash; correcting it to
    // 100% bonus means clawing ~90% of the credited amount back into bonus. This
    // is the INTENDED move BEFORE the wallet clamp — the exact figure (and any
    // shortfall if the cash was already withdrawn) is computed at apply time by
    // reclaim_slip_bonus_split. `won` uses the paid payout; `voided` the refund
    // (= net stake). Estimate only, for triage.
    const finalPayout = Number(s.final_payout_tngn || 0);
    const estimatedReclaim =
      status === 'won' ? Math.round(finalPayout * 0.90) :
      status === 'voided' ? Math.round(finalPayout) :
      0;
    return {
      slipId: s.id,
      userId: s.user_id,
      handle: ctx.handle ?? 'user',
      status,
      slipStakeTngn: Number(s.slip_stake_tngn || 0),
      netSlipStakeTngn: Number(s.net_slip_stake_tngn || 0),
      payoutTngn: Number(s.payout_tngn || 0),
      finalPayoutTngn: finalPayout,
      // Money that would move cash -> bonus if corrected (settled slips only,
      // pre-clamp estimate). 0 for active (no money moved yet) and lost.
      estimatedReclaimTngn: estimatedReclaim,
      placedAt: s.created_at,
      currentTngnBalance: ctx.currentTngn ?? null,
      currentBonusBalance: ctx.currentBonus ?? null,
      lifetimeBonusGranted: ctx.lifetimeBonusGranted ?? null,
      // Best-effort signal only — NOT a certainty. True if the user has
      // any bonus footprint at all.
      likelyBonusFunded: (ctx.currentBonus ?? 0) > 0 || (ctx.lifetimeBonusGranted ?? 0) > 0,
      // Correctable: active (flip the record) or settled won/voided (reclaim
      // money). A lost slip moved no payout, so there is nothing to correct.
      fixable: status === 'active' || status === 'won' || status === 'voided',
    };
  });

  const summary = {
    total: candidates.length,
    active: candidates.filter(c => c.status === 'active').length,
    settled: candidates.filter(c => c.status !== 'active').length,
    fixable: candidates.filter(c => c.fixable).length,
    note: 'proportion=0 is ambiguous (also legit for all-cash slips). Exact split is not reconstructable — treat as review candidates. Active slips flip the record before resolution; settled won/voided slips reclaim over-paid cash back to bonus (clamped to the wallet — already-withdrawn cash cannot be recovered).',
  };

  return NextResponse.json({ candidates, summary }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const slipIds: string[] = Array.isArray(body?.slipIds) ? body.slipIds.map(String) : [];
  const dryRun = body?.dryRun !== false; // default to dry run — must opt out to write
  if (slipIds.length === 0) {
    return NextResponse.json({ error: 'Provide slipIds' }, { status: 400 });
  }

  // Load the targeted slips and classify by status. Active slips are fixed by
  // flipping the record; settled won/voided slips by reclaiming money; lost
  // slips have no payout to correct.
  const { data: slips, error } = await supabaseAdmin
    .from('multiplier_slips')
    .select('id, user_id, status, bonus_proportion, slip_stake_tngn')
    .in('id', slipIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const found = new Set((slips || []).map(s => s.id));
  const notFound = slipIds.filter(id => !found.has(id));

  const activeSlips = (slips || []).filter(s => s.status === 'active');
  const settledPaid = (slips || []).filter(s => s.status === 'won' || s.status === 'voided');
  const lostSkipped = (slips || []).filter(s => s.status === 'lost').map(s => ({ slipId: s.id, status: s.status }));

  const activeAlreadyFull = activeSlips.filter(s => Number(s.bonus_proportion ?? 0) === 1);
  const activeToFlip = activeSlips.filter(s => Number(s.bonus_proportion ?? 0) !== 1);

  // ── DRY RUN ──────────────────────────────────────────────────────────────
  // Active slips: a straight record flip. Settled slips: ask the reclaim RPC
  // (dry_run = true) for the exact cash it would move and any shortfall.
  if (dryRun) {
    const willReclaim: any[] = [];
    for (const s of settledPaid) {
      const { data, error: rpcErr } = await supabaseAdmin
        .rpc('reclaim_slip_bonus_split', { p_slip_id: s.id, p_target_proportion: 1.0, p_dry_run: true });
      const row = Array.isArray(data) ? data[0] : data;
      willReclaim.push({
        slipId: s.id,
        userId: s.user_id,
        status: s.status,
        reason: rpcErr ? rpcErr.message : row?.reason,
        cashToMove: Number(row?.cash_moved ?? 0),
        bonusToAdd: Number(row?.bonus_added ?? 0),
        shortfall: Number(row?.shortfall ?? 0),
      });
    }
    return NextResponse.json({
      dryRun: true,
      willUpdate: activeToFlip.map(s => ({ slipId: s.id, userId: s.user_id, fromProportion: Number(s.bonus_proportion ?? 0), toProportion: 1.0 })),
      willReclaim,
      lostSkipped,
      notFound,
      alreadyFullBonus: activeAlreadyFull.map(s => s.id),
    });
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  // 1) Active slips: flip bonus_proportion, re-checking status under the write
  //    so a slip that settles concurrently is never silently touched.
  const flipped: string[] = [];
  for (const s of activeToFlip) {
    const { data: upd, error: updErr } = await supabaseAdmin
      .from('multiplier_slips')
      .update({ bonus_proportion: 1.0 })
      .eq('id', s.id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    if (updErr || !upd) continue;
    flipped.push(s.id);
    await supabaseAdmin.from('treasury_log').insert({
      type: 'slip_bonus_proportion_correction',
      amount_tngn: 0,
      user_id: s.user_id,
      metadata: {
        slip_id: s.id,
        from_proportion: Number(s.bonus_proportion ?? 0),
        to_proportion: 1.0,
        reason: 'bonus_regression_20260710010000_repair',
      },
    }).then(() => undefined, () => undefined);
  }

  // 2) Settled won/voided slips: reclaim the over-paid cash into bonus. The RPC
  //    is atomic + idempotent (a re-run returns reason 'already_reclaimed') and
  //    clamps to the wallet, so already-withdrawn cash surfaces as shortfall.
  const reclaimed: any[] = [];
  for (const s of settledPaid) {
    const { data, error: rpcErr } = await supabaseAdmin
      .rpc('reclaim_slip_bonus_split', { p_slip_id: s.id, p_target_proportion: 1.0, p_dry_run: false });
    const row = Array.isArray(data) ? data[0] : data;
    reclaimed.push({
      slipId: s.id,
      userId: s.user_id,
      status: s.status,
      applied: rpcErr ? false : !!row?.applied,
      reason: rpcErr ? rpcErr.message : row?.reason,
      cashMoved: Number(row?.cash_moved ?? 0),
      bonusAdded: Number(row?.bonus_added ?? 0),
      shortfall: Number(row?.shortfall ?? 0),
    });
  }

  const reclaimApplied = reclaimed.filter(r => r.applied);
  return NextResponse.json({
    dryRun: false,
    flipped,
    flippedCount: flipped.length,
    reclaimed,
    reclaimedCount: reclaimApplied.length,
    totalCashReclaimed: Math.round(reclaimApplied.reduce((a, r) => a + r.cashMoved, 0)),
    totalShortfall: Math.round(reclaimApplied.reduce((a, r) => a + r.shortfall, 0)),
    // Back-compat aggregate for the UI toast.
    appliedCount: flipped.length + reclaimApplied.length,
    lostSkipped,
    notFound,
    alreadyFullBonus: activeAlreadyFull.map(s => s.id),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
