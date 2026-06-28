import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import {
  settleLockedMarket,
  type LockedBet,
  type MarketResolution,
} from '@/lib/lockedSettlement';
import { displayFloorPayout } from '@/lib/displayMultiplier';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Flat 10% of the TOTAL pool taken at resolution. Replaces the old
// 5%-of-losing-pool model. Aligns with what users see — getDisplayPool()
// already shows the post-rake pool, so winners share exactly that number.
// VIP referrers earn a slice of this rake from their referred users' bets
// only — see splitResolutionRakeForVipReferrers below.
const POOL_RAKE_PCT = 0.10;
const BET_INSURANCE_CAP = 2000;

// Random Bet Insurance — formerly "First Bet Insurance".
//
// Triggers:
//   (a) FIRST bet ever resolved and it lost  — always insured
//   (b) Random luck-of-the-draw: with probability scaling by user lifetime
//       bet volume (more bets played = small extra chance per loss), any
//       single losing bet may get refunded as bonus_balance. Cap per bet.
//
// Anti-abuse:
//   - Only one (b) refund per user per rolling 14-day window
//   - (b) probability never exceeds 5% per bet — bounded house cost
async function applyFirstBetInsurance(userId: string, bet: any, marketId: number | bigint | string) {
  // Check (a) — was this the user's first ever resolved bet?
  const { count: resolvedCount } = await supabaseAdmin
    .from('user_bets')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['won', 'lost']);

  const isFirstEver = resolvedCount === 1;
  let trigger: 'first_bet' | 'random_volume_based' | null = null;

  if (isFirstEver) {
    trigger = 'first_bet';
  } else {
    // (b) Random insurance — eligible if user has at least 10 lifetime bets
    // and hasn't been refunded by (b) in the last 14 days.
    const { count: lifetimeCount } = await supabaseAdmin
      .from('user_bets')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if ((lifetimeCount || 0) < 10) return;

    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { count: recentRandomCount } = await supabaseAdmin
      .from('bet_insurance_events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('trigger_reason', 'random_volume_based')
      .gte('created_at', fourteenDaysAgo);

    if ((recentRandomCount || 0) > 0) return;

    // Probability ramp: 1% at 10 bets, capped at 5% past 100 bets.
    const baseProbability = Math.min(0.05, 0.01 + ((lifetimeCount || 10) - 10) * 0.0004);
    if (Math.random() >= baseProbability) return;

    trigger = 'random_volume_based';
  }

  if (!trigger) return;

  const refundAmount = Math.min(bet.stake_tngn, BET_INSURANCE_CAP);

  // Atomic increment via credit_user RPC — no read-then-write race.
  await supabaseAdmin.rpc('credit_user', {
    p_user_id: userId,
    p_tngn_delta: 0,
    p_bonus_delta: refundAmount,
  });

  // Legacy flag — kept for back-compat with the bets-page UI badge.
  if (trigger === 'first_bet') {
    await supabaseAdmin.from('user_bets').update({ is_first_bet_refunded: true }).eq('id', bet.id);
  }

  // New canonical event log
  await supabaseAdmin.from('bet_insurance_events').insert({
    user_id: userId,
    bet_id: bet.id,
    market_id: marketId,
    refund_amount_tngn: refundAmount,
    trigger_reason: trigger,
  });

  const niceLabel = trigger === 'first_bet' ? 'first bet' : 'lucky day';
  await supabaseAdmin.from('notifications').insert({
    user_id: userId,
    type: 'bet_insurance_refund',
    message: `Tough break! Your ${niceLabel} is insured. ₦${refundAmount.toLocaleString()} has been added to your bonus balance. 🛡`,
    amount: refundAmount,
  });

  await supabaseAdmin.from('treasury_log').insert({
    type: 'bet_insurance',
    amount_tngn: refundAmount,
    bet_id: bet.id,
    user_id: userId,
    metadata: { source: trigger },
    created_at: new Date().toISOString(),
  });

  console.log(`Bet Insurance (${trigger}): user=${userId} refund=${refundAmount} tNGN`);
}

// Locked-odds settlement path.
//
// Pays each winner MAX(floor, parimutuel-with-vig) using the bet's
// frozen locked_odds + vig_at_stake_pct. House P&L is computed from
// the in-memory summary and applied atomically to house_reserve via
// apply_house_pnl. market_liability is cleared at the end.
//
// Reuses the existing applyFirstBetInsurance helper and points-award
// pattern — those policies are independent of pricing engine.
//
// VIP rake-share formula CHANGES for locked-odds bets: instead of a
// slice of the pool rake, the VIP gets a slice of the bet's
// contribution to house margin (net_stake × vig_at_stake × share%).
// See lib/lockedSettlement.calculateLockedVipCut.
async function resolveLockedOddsMarket(args: {
  marketId: number | bigint | string;
  winningOutcomeIndex: number;
  market: any;
}) {
  const { marketId, winningOutcomeIndex, market } = args;

  // Multiplier legs on this market are settled by the POST handler
  // before it branches here — for both engines — so nothing to do for
  // legs in this function anymore.

  // Pull every active bet on this market, including the locked-odds
  // fields. The same row-shape supplies the LockedBet input to the
  // settlement library and the bet rows we'll mark won/lost/refunded.
  const { data: rawBets } = await supabaseAdmin
    .from('user_bets')
    .select('id, user_id, outcome_index, net_stake_tngn, stake_tngn, locked_odds, vig_at_stake_pct, tier')
    .eq('market_id', marketId)
    .eq('status', 'active');

  if (!rawBets || rawBets.length === 0) {
    await supabaseAdmin.from('markets').update({ status: 'voided', resolved_outcome: null }).eq('id', marketId);
    await supabaseAdmin.rpc('clear_market_liability', { p_market_id: marketId });
    return NextResponse.json({ status: 'voided', reason: 'No bets placed' });
  }

  // Integrity gate: a locked-odds market should never have a bet
  // missing locked_odds / vig_at_stake_pct. The placement RPCs set
  // both at stake time; a row missing either means something upstream
  // misbehaved. The old code SILENTLY REFUNDED these rows, which is
  // exactly the leftover pattern that wrongly refunded yesterday's
  // losers — a future regression that minted a malformed bet would
  // replay the bug.
  //
  // Now: abort the resolution and surface the problem. The bets stay
  // ACTIVE (not refunded, not lost) and the market stays LOCKED, so
  // ops can investigate, reconcile by hand, and re-run resolve once
  // the malformed rows are explained. Nobody gets a wrong outcome.
  const malformed = rawBets.filter(b => b.locked_odds == null || b.vig_at_stake_pct == null);
  if (malformed.length > 0) {
    console.error(`Locked-odds resolve aborted: ${malformed.length} bet(s) missing locked_odds/vig on market ${marketId}`, {
      malformedBetIds: malformed.map(b => b.id),
    });
    // Release the resolve-race claim so the market doesn't get stuck.
    await supabaseAdmin
      .from('markets')
      .update({ resolved_outcome: null })
      .eq('id', marketId);
    return NextResponse.json(
      {
        error: 'Resolution halted: malformed bets detected on a locked-odds market. Investigate before retrying.',
        marketId,
        malformedBetCount: malformed.length,
        malformedBetIds: malformed.map(b => b.id),
      },
      { status: 422 },
    );
  }

  const wellFormed = rawBets;

  // Preload VIP referral info — same shape as the parimutuel branch.
  const losingUserIds = Array.from(new Set(
    wellFormed.filter(b => b.outcome_index !== winningOutcomeIndex).map(b => b.user_id),
  ));
  const referrerByUser: Record<string, { vipId: string; sharePct: number }> = {};
  if (losingUserIds.length > 0) {
    const { data: refRows } = await supabaseAdmin
      .from('users')
      .select('id, referred_by_user_id, referred_by_is_vip')
      .in('id', losingUserIds);
    const vipIds = (refRows || [])
      .filter(r => r.referred_by_is_vip && r.referred_by_user_id)
      .map(r => r.referred_by_user_id);
    let rakeMap: Record<string, number> = {};
    if (vipIds.length > 0) {
      const { data: codes } = await supabaseAdmin
        .from('referral_codes')
        .select('owner_user_id, rake_share_pct')
        .in('owner_user_id', vipIds)
        .eq('is_vip_code', true)
        .eq('is_active', true);
      rakeMap = Object.fromEntries((codes || []).map(c => [c.owner_user_id, Number(c.rake_share_pct) || 0]));
    }
    for (const r of refRows || []) {
      if (r.referred_by_is_vip && r.referred_by_user_id && rakeMap[r.referred_by_user_id]) {
        referrerByUser[r.id] = {
          vipId: r.referred_by_user_id,
          sharePct: rakeMap[r.referred_by_user_id],
        };
      }
    }
  }

  // Extract seed_pool and pool_by_outcome into ordered numeric arrays.
  // jsonb keyed by outcome_index::text → numeric[] in [0..n-1] order.
  const optionsLen = (market.options as any[]).length;
  const toArray = (j: any): number[] => {
    const arr: number[] = [];
    const src = j || {};
    for (let i = 0; i < optionsLen; i++) {
      const v = Number(src[String(i)] ?? 0);
      arr.push(Number.isFinite(v) && v > 0 ? v : 0);
    }
    return arr;
  };

  const resolution: MarketResolution = {
    seedPool: toArray(market.seed_pool),
    realPool: toArray(market.pool_by_outcome),
    winningOutcomeIndex,
  };

  // Build the LockedBet input array. VIP context joined in here so
  // settleLockedMarket can return VIP cuts in the same pass.
  const lockedBets: LockedBet[] = wellFormed.map(b => {
    const ref = referrerByUser[b.user_id];
    return {
      id: b.id,
      userId: b.user_id,
      outcomeIndex: b.outcome_index,
      stakeTngn: Number(b.stake_tngn),
      netStakeTngn: Number(b.net_stake_tngn),
      lockedOdds: Number(b.locked_odds),
      vigAtStakePct: Number(b.vig_at_stake_pct),
      vipRakeSharePct: ref?.sharePct,
      vipReferrerId: ref?.vipId,
    };
  });

  const summary = settleLockedMarket(lockedBets, resolution);

  // No-winners case: the winning outcome had zero bets. Used to void
  // + refund; the platform doesn't have a void state anymore. Every
  // bet loses, house keeps the net stakes, market resolves normally.
  // The all-winners case (everyone bet the winning side) used to share
  // the same void block — that now falls through to the normal payment
  // path below, where each winner gets their locked-odds floor payout
  // and apply_house_pnl absorbs the negative gap.
  const winnerCount = lockedBets.filter(b => b.outcomeIndex === winningOutcomeIndex).length;
  if (winnerCount === 0) {
    let totalHouseGain = 0;
    for (const lb of lockedBets) {
      await supabaseAdmin.from('user_bets').update({ status: 'lost', payout_tngn: 0 }).eq('id', lb.id);
      await applyFirstBetInsurance(lb.userId, { id: lb.id, stake_tngn: lb.stakeTngn }, marketId);
      try {
        await supabaseAdmin.from('notifications').insert({
          user_id: lb.userId,
          type: 'bet_lost',
          message: `Your prediction didn't land this time — better luck on the next call.`,
        });
      } catch { /* non-critical */ }
      totalHouseGain += lb.netStakeTngn;
    }

    const { data: reserveAfter, error: reserveErr } = await supabaseAdmin
      .rpc('apply_house_pnl', {
        p_pnl_tngn: totalHouseGain,
        p_market_id: marketId,
      })
      .single<{ total_tngn: number; floor_tngn: number; deployable_tngn: number }>();
    if (reserveErr) {
      console.error('apply_house_pnl failed at locked-odds no-winners settlement:', reserveErr);
    }

    await supabaseAdmin.from('treasury_log').insert({
      type: 'locked_settlement_pnl',
      amount_tngn: totalHouseGain,
      market_id: marketId,
      metadata: {
        bet_count: lockedBets.length,
        winners: 0,
        losers: lockedBets.length,
        no_winners: true,
        reserve_after: reserveAfter ?? null,
      },
      created_at: new Date().toISOString(),
    });

    await supabaseAdmin.from('markets').update({
      status: 'resolved',
      resolved_outcome: winningOutcomeIndex,
      resolved_at: new Date().toISOString(),
    }).eq('id', marketId);
    await supabaseAdmin.rpc('clear_market_liability', { p_market_id: marketId });

    return NextResponse.json({
      success: true,
      status: 'resolved',
      winnersCount: 0,
      losersCount: lockedBets.length,
      houseGainTngn: totalHouseGain,
    });
  }

  // Pay winners + award win points.
  for (const p of summary.perBet) {
    if (!p.won) continue;
    const lb = lockedBets.find(x => x.id === p.betId)!;
    await supabaseAdmin.rpc('credit_user', {
      p_user_id: lb.userId,
      p_tngn_delta: p.payoutTngn,
      p_bonus_delta: 0,
    });
    await supabaseAdmin.from('user_bets').update({ status: 'won', payout_tngn: p.payoutTngn }).eq('id', lb.id);

    const profit = Math.max(0, p.payoutTngn - lb.stakeTngn);
    const winPoints = Math.max(0, Math.floor(profit / 100));
    if (winPoints > 0) {
      await supabaseAdmin.rpc('award_points', {
        p_user_id: lb.userId,
        p_reason: 'bet_win',
        p_points: winPoints,
        p_bet_id: lb.id,
        p_metadata: { payout: p.payoutTngn, profit, locked_odds: lb.lockedOdds, floor_bound: p.floorBound, upside_bound: p.upsideBound },
      });
    }

    try {
      await supabaseAdmin.from('notifications').insert({
        user_id: lb.userId,
        type: 'bet_won',
        message: `You won! ₦${p.payoutTngn.toLocaleString()} has been credited to your account. 🎉`,
        amount: p.payoutTngn,
      });
    } catch { /* non-critical */ }
  }

  // Mark losers + insurance + loss notification.
  // The win path notifies — without a matching loss notification users
  // wouldn't know their bet was resolved at all (they'd just notice the
  // balance hadn't changed). UX-asymmetric notifications also feel
  // misleading: silence on a loss reads as "still pending".
  for (const p of summary.perBet) {
    if (p.won) continue;
    const lb = lockedBets.find(x => x.id === p.betId)!;
    await supabaseAdmin.from('user_bets').update({ status: 'lost', payout_tngn: 0 }).eq('id', lb.id);
    await applyFirstBetInsurance(lb.userId, { id: lb.id, stake_tngn: lb.stakeTngn }, marketId);
    try {
      await supabaseAdmin.from('notifications').insert({
        user_id: lb.userId,
        type: 'bet_lost',
        message: `Your prediction didn't land this time — better luck on the next call.`,
      });
    } catch { /* non-critical */ }
  }

  // VIP cuts — routed in one pass from the summary so we don't
  // recompute the math.
  for (const cut of summary.vipCuts) {
    await supabaseAdmin.rpc('credit_user', {
      p_user_id: cut.vipReferrerId,
      p_tngn_delta: 0,
      p_bonus_delta: cut.amountTngn,
    });
    await supabaseAdmin.from('vip_referral_earnings').insert({
      vip_user_id: cut.vipReferrerId,
      referred_user_id: lockedBets.find(b => b.id === cut.betId)!.userId,
      bet_id: cut.betId,
      market_id: marketId,
      rake_share_pct: lockedBets.find(b => b.id === cut.betId)!.vipRakeSharePct,
      rake_share_amount: cut.amountTngn,
      metadata: { basis: cut.basis },
    });
  }

  // House P&L → reserve. Single atomic RPC.
  const { data: reserveAfter, error: reserveErr } = await supabaseAdmin
    .rpc('apply_house_pnl', {
      p_pnl_tngn: summary.houseProfitTngn,
      p_market_id: marketId,
    })
    .single<{ total_tngn: number; floor_tngn: number; deployable_tngn: number }>();
  if (reserveErr) {
    console.error('apply_house_pnl failed at locked-odds settlement:', reserveErr);
    // Don't fail the resolution; the payouts above have already
    // gone out. Surface the failure for ops, but keep going so the
    // market is at least marked resolved.
  }

  // Treasury log — house margin captured. Single entry per resolved
  // locked-odds market, mirroring the parimutuel branch's
  // resolution_rake entry. metadata carries the diagnostic detail.
  await supabaseAdmin.from('treasury_log').insert({
    type: 'locked_settlement_pnl',
    amount_tngn: summary.houseProfitTngn,
    market_id: marketId,
    metadata: {
      total_winner_payouts: summary.totalWinnerPayouts,
      total_vip_payouts: summary.totalVipPayouts,
      bet_count: lockedBets.length,
      winners: summary.perBet.filter(p => p.won).length,
      losers: summary.perBet.filter(p => !p.won).length,
      reserve_after: reserveAfter ?? null,
    },
    created_at: new Date().toISOString(),
  });

  // Clear the open-exposure ledger row.
  await supabaseAdmin.rpc('clear_market_liability', { p_market_id: marketId });

  // Finalise market status.
  const totalPool = lockedBets.reduce((a, b) => a + b.netStakeTngn, 0);
  await supabaseAdmin.from('markets').update({
    status: 'resolved',
    resolved_outcome: winningOutcomeIndex,
    total_pool: totalPool,
    resolved_at: new Date().toISOString(),
  }).eq('id', marketId);

  console.log(`Market ${marketId} resolved (locked-odds). Winners: ${summary.perBet.filter(p => p.won).length}. House P&L: ${summary.houseProfitTngn}.`);

  return NextResponse.json({
    success: true,
    engine: 'locked_odds',
    marketId,
    winningOutcomeIndex,
    totalPool,
    winnersCount: summary.perBet.filter(p => p.won).length,
    losersCount: summary.perBet.filter(p => !p.won).length,
    totalWinnerPayouts: summary.totalWinnerPayouts,
    totalVipPayouts: summary.totalVipPayouts,
    houseProfit: summary.houseProfitTngn,
    reserveAfter,
  }, { status: 200 });
}

export async function POST(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret');
    const isValidCron = cronSecret === process.env.CRON_SECRET;
    const isValidAdmin = isAdminRequest(request);
    if (!isValidCron && !isValidAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { marketId, winningOutcomeIndex } = await request.json();
    if (!marketId || winningOutcomeIndex === undefined) {
      return NextResponse.json({ error: 'Missing marketId or winningOutcomeIndex' }, { status: 400 });
    }

    const { data: market, error: marketError } = await supabaseAdmin
      .from('markets').select('*').eq('id', marketId).single();

    if (marketError || !market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    if (market.status !== 'locked') return NextResponse.json({ error: 'Market must be locked before resolving' }, { status: 400 });

    // Race lock — concurrent resolve calls (admin double-click, retried
    // cron) would both pass the status check above and double-pay every
    // winner. Atomically claim the resolve by flipping resolved_outcome
    // from NULL to the winning index; whoever gets the row back owns it.
    // If we lose the race, bail with 409 — the other call will finish
    // the payouts.
    const { data: claim } = await supabaseAdmin
      .from('markets')
      .update({
        resolved_outcome: winningOutcomeIndex,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', marketId)
      .eq('status', 'locked')
      .is('resolved_outcome', null)
      .select('id')
      .maybeSingle();

    if (!claim) {
      return NextResponse.json(
        { error: 'Resolution already in progress or completed for this market' },
        { status: 409 },
      );
    }

    // Settle any Multiplier legs riding on THIS market — for BOTH
    // engines. Legs pay from the house at fixed odds and are
    // independent of the single-bet pool, so a leg can sit on any
    // market regardless of its pricing engine. Previously this only
    // ran inside the locked-odds branch, so a leg whose market
    // resolved through the parimutuel path was orphaned forever — the
    // slip never advanced and the user never saw a result. Running it
    // here, before the engine branch, settles legs on every
    // resolution. Idempotent: the RPC only touches status='active'
    // legs, so a re-resolve or double-call is safe. p_voided=false —
    // the resolve route always carries a real winning outcome.
    try {
      await supabaseAdmin.rpc('settle_multiplier_for_market', {
        p_market_id: marketId,
        p_winning_outcome: winningOutcomeIndex,
        p_voided: false,
      });
    } catch (e) {
      console.error(`settle_multiplier_for_market failed for market ${marketId}:`, e);
      // Don't abort single-bet settlement on a multiplier hiccup —
      // surface for ops and continue. Active legs retry-settle if the
      // market is re-resolved or via the admin repair endpoint.
    }

    // Branch on the market's pricing engine BEFORE reading bets, so
    // the locked-odds path can request the extra columns it needs
    // (locked_odds, vig_at_stake_pct) in a single query. Existing
    // parimutuel markets keep using the original SELECT to avoid any
    // change to their query shape.
    if (market.is_locked_odds) {
      return await resolveLockedOddsMarket({
        marketId,
        winningOutcomeIndex,
        market,
      });
    }

    const { data: bets } = await supabaseAdmin
      .from('user_bets')
      .select('id, user_id, outcome_index, net_stake_tngn, stake_tngn')
      .eq('market_id', marketId)
      .eq('status', 'active');

    if (!bets || bets.length === 0) {
      await supabaseAdmin.from('markets').update({ status: 'voided', resolved_outcome: null }).eq('id', marketId);
      return NextResponse.json({ status: 'voided', reason: 'No bets placed' });
    }

    const winningBets = bets.filter(b => b.outcome_index === winningOutcomeIndex);
    const losingBets = bets.filter(b => b.outcome_index !== winningOutcomeIndex);
    const winningPool = winningBets.reduce((s, b) => s + b.net_stake_tngn, 0);
    const losingPool = losingBets.reduce((s, b) => s + b.net_stake_tngn, 0);
    const totalPool = winningPool + losingPool;

    // The platform doesn't have a void state anymore — both empty-pool
    // edge cases resolve normally:
    //
    //   winningPool === 0  → everyone bet a losing outcome. Mark every
    //   bet lost, fire the loss UX (insurance + notification), route
    //   the full gross pool to the house. No winners to share with.
    //
    //   losingPool === 0   → everyone bet the winner. There's no losing
    //   pool to fund a pro-rata multiplier, so pay the friendly floor
    //   (1.03/1.02× per lib/displayMultiplier) on each winning stake.
    //   House tops up the small delta — same cost we'd pay on a
    //   first-mover refund, just landed via a win row instead.
    //
    // VIP rake routing only fires in the standard mixed-pool branch
    // below — there's no rake on the floor case (no losing pool to
    // derive from) and no normal rake on the all-losers case either
    // (we already route the entire pool to the house).
    if (winningPool === 0) {
      for (const bet of bets) {
        await supabaseAdmin.from('user_bets').update({ status: 'lost', payout_tngn: 0 }).eq('id', bet.id);
        await applyFirstBetInsurance(bet.user_id, bet, marketId);
        try {
          await supabaseAdmin.from('notifications').insert({
            user_id: bet.user_id,
            type: 'bet_lost',
            message: `Your prediction didn't land this time — better luck on the next call.`,
          });
        } catch { /* non-critical */ }
      }

      await supabaseAdmin.from('treasury_log').insert({
        type: 'resolution_rake',
        amount_tngn: totalPool,
        market_id: marketId,
        metadata: { gross_pool: totalPool, no_winners: true, vip_payout_total: 0 },
        created_at: new Date().toISOString(),
      });

      await supabaseAdmin.from('markets').update({
        status: 'resolved',
        resolved_outcome: winningOutcomeIndex,
        total_pool: totalPool,
        resolved_at: new Date().toISOString(),
      }).eq('id', marketId);

      return NextResponse.json({
        success: true,
        status: 'resolved',
        winnersCount: 0,
        losersCount: bets.length,
        totalPool,
      });
    }

    if (losingPool === 0) {
      for (const bet of winningBets) {
        const floorPayout = displayFloorPayout(Number(bet.stake_tngn) || 0).payout;
        const payout = Math.max(Number(bet.net_stake_tngn) || 0, floorPayout);
        await supabaseAdmin.rpc('credit_user', {
          p_user_id: bet.user_id,
          p_tngn_delta: payout,
          p_bonus_delta: 0,
        });
        await supabaseAdmin.from('user_bets').update({ status: 'won', payout_tngn: payout }).eq('id', bet.id);

        const profit = Math.max(0, payout - Number(bet.stake_tngn));
        const winPoints = Math.max(0, Math.floor(profit / 100));
        if (winPoints > 0) {
          await supabaseAdmin.rpc('award_points', {
            p_user_id: bet.user_id,
            p_reason: 'bet_win',
            p_points: winPoints,
            p_bet_id: bet.id,
            p_metadata: { payout, profit, all_winners: true },
          });
        }

        try {
          await supabaseAdmin.from('notifications').insert({
            user_id: bet.user_id,
            type: 'bet_won',
            message: `You won! ₦${Math.round(payout).toLocaleString()} has been credited to your account. 🎉`,
            amount: payout,
          });
        } catch { /* non-critical */ }
      }

      await supabaseAdmin.from('markets').update({
        status: 'resolved',
        resolved_outcome: winningOutcomeIndex,
        total_pool: totalPool,
        resolved_at: new Date().toISOString(),
      }).eq('id', marketId);

      return NextResponse.json({
        success: true,
        status: 'resolved',
        winnersCount: winningBets.length,
        losersCount: 0,
        totalPool,
      });
    }

    // 10% of total pool comes out as house rake. Whatever's left is split
    // among winners pro-rata to their net stake.
    const grossRake = totalPool * POOL_RAKE_PCT;
    const payoutPool = totalPool - grossRake;

    // VIP referrer rake split: when a bet's user was referred by a VIP, a
    // configurable slice of THAT BET's contribution to the rake is routed
    // to the VIP's bonus_balance. House keeps the rest. Computed per-bet so
    // VIPs only earn from their own referees.
    let vipPayoutTotal = 0;
    const losingUserIds = Array.from(new Set(losingBets.map(b => b.user_id)));

    // Pre-load referrer + VIP rake_share_pct for every losing user in one query.
    const referrerByUser: Record<string, { vipId: string; sharePct: number }> = {};
    if (losingUserIds.length > 0) {
      const { data: refRows } = await supabaseAdmin
        .from('users')
        .select('id, referred_by_user_id, referred_by_is_vip')
        .in('id', losingUserIds);

      const vipIds = (refRows || [])
        .filter(r => r.referred_by_is_vip && r.referred_by_user_id)
        .map(r => r.referred_by_user_id);

      let rakeMap: Record<string, number> = {};
      if (vipIds.length > 0) {
        const { data: codes } = await supabaseAdmin
          .from('referral_codes')
          .select('owner_user_id, rake_share_pct')
          .in('owner_user_id', vipIds)
          .eq('is_vip_code', true)
          .eq('is_active', true);
        rakeMap = Object.fromEntries((codes || []).map(c => [c.owner_user_id, Number(c.rake_share_pct) || 0]));
      }

      for (const r of refRows || []) {
        if (r.referred_by_is_vip && r.referred_by_user_id && rakeMap[r.referred_by_user_id]) {
          referrerByUser[r.id] = {
            vipId: r.referred_by_user_id,
            sharePct: rakeMap[r.referred_by_user_id],
          };
        }
      }
    }

    // Pay winners + award win points. Each winner is paid the MAX of
    // the parimutuel share AND the friendly floor (1.03× under ₦500,
    // 1.02× at/above — see lib/displayMultiplier). The floor is the
    // promise the bet modal made at stake time; it has to bind here or
    // a thinly-betted winner could be paid less than their displayed
    // ₦X-if-correct number. House tops up the small delta when the
    // floor exceeds the pro-rata share.
    for (const bet of winningBets) {
      const share = bet.net_stake_tngn / winningPool;
      const parimutuelPayout = share * payoutPool;
      const floorPayout = displayFloorPayout(Number(bet.stake_tngn) || 0).payout;
      const payout = Math.max(parimutuelPayout, floorPayout);

      await supabaseAdmin.rpc('credit_user', {
        p_user_id: bet.user_id,
        p_tngn_delta: payout,
        p_bonus_delta: 0,
      });
      await supabaseAdmin.from('user_bets').update({ status: 'won', payout_tngn: payout }).eq('id', bet.id);

      // Win points: 1 pt per ₦100 of profit (payout above stake)
      const profit = Math.max(0, payout - bet.stake_tngn);
      const winPoints = Math.max(0, Math.floor(profit / 100));
      if (winPoints > 0) {
        await supabaseAdmin.rpc('award_points', {
          p_user_id: bet.user_id,
          p_reason: 'bet_win',
          p_points: winPoints,
          p_bet_id: bet.id,
          p_metadata: { payout, profit, parimutuel: parimutuelPayout, floor: floorPayout },
        });
      }

      try {
        await supabaseAdmin.from('notifications').insert({
          user_id: bet.user_id,
          type: 'bet_won',
          message: `You won! ₦${Math.round(payout).toLocaleString()} has been credited to your account. 🎉`,
          amount: payout,
        });
      } catch (err) {
        // non-critical
      }
    }

    // Mark losers + apply Random Bet Insurance + route VIP rake share +
    // loss notification (mirrors the locked-odds branch above so the
    // user always hears from us when their bet resolves).
    for (const bet of losingBets) {
      await supabaseAdmin.from('user_bets').update({ status: 'lost', payout_tngn: 0 }).eq('id', bet.id);
      await applyFirstBetInsurance(bet.user_id, bet, marketId);
      try {
        await supabaseAdmin.from('notifications').insert({
          user_id: bet.user_id,
          type: 'bet_lost',
          message: `Your prediction didn't land this time — better luck on the next call.`,
        });
      } catch { /* non-critical */ }

      // This bet's pro-rata share of the gross rake.
      const betRakeContribution = (bet.net_stake_tngn / totalPool) * grossRake;

      const ref = referrerByUser[bet.user_id];
      if (ref && ref.sharePct > 0 && betRakeContribution > 0) {
        const vipCut = betRakeContribution * (ref.sharePct / 100);
        if (vipCut > 0) {
          await supabaseAdmin.rpc('credit_user', {
            p_user_id: ref.vipId,
            p_tngn_delta: 0,
            p_bonus_delta: vipCut,
          });
          await supabaseAdmin.from('vip_referral_earnings').insert({
            vip_user_id: ref.vipId,
            referred_user_id: bet.user_id,
            bet_id: bet.id,
            market_id: marketId,
            rake_share_pct: ref.sharePct,
            rake_share_amount: vipCut,
          });
          vipPayoutTotal += vipCut;
        }
      }
    }

    const houseRakeNet = grossRake - vipPayoutTotal;

    // Resolution rake to treasury (house's net portion only — VIP slices
    // are already credited to the VIPs and logged in vip_referral_earnings).
    await supabaseAdmin.from('treasury_log').insert({
      type: 'resolution_rake',
      amount_tngn: houseRakeNet,
      market_id: marketId,
      metadata: { gross_rake: grossRake, vip_payout_total: vipPayoutTotal },
      created_at: new Date().toISOString(),
    });

    await supabaseAdmin.from('markets').update({
      status: 'resolved',
      resolved_outcome: winningOutcomeIndex,
      total_pool: totalPool,
      resolved_at: new Date().toISOString(),
    }).eq('id', marketId);

    console.log(`Market ${marketId} resolved. Winners: ${winningBets.length}. Pool: ${totalPool}. Rake (gross/house/vip): ${grossRake}/${houseRakeNet}/${vipPayoutTotal}.`);

    return NextResponse.json({
      success: true,
      marketId,
      winningOutcomeIndex,
      totalPool,
      winningPool,
      losingPool,
      grossRake,
      houseRakeNet,
      vipPayoutTotal,
      payoutPool,
      winnersCount: winningBets.length,
      losersCount: losingBets.length,
    }, { status: 200 });

  } catch (error: any) {
    console.error('Market resolution error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
