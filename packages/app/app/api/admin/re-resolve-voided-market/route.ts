import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getBaseUrl, cronHeaders } from '@/lib/oracle';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/re-resolve-voided-market
//
// Recovers a market that was wrongly voided by finalizing it against the
// REAL outcome and paying winners at their true odds. Refunding stakes
// is not enough — winners should get their WINNINGS.
//
// Mechanism:
//   1. Reverses the refunds already handed out by the wrongful void:
//      every user_bets row still status='refunded' on this market had
//      its net stake credited back to the user at void time. Clawback
//      that credit so we start from a clean pre-void balance state.
//   2. Resets the market and its bets/legs to the pre-resolution shape:
//        markets.status         → 'locked'
//        markets.resolved_*     → null
//        user_bets.status       → 'active' (were 'refunded' from the wrongful void)
//        multiplier_legs.status → 'active' (were 'void' from the wrongful settlement)
//        multiplier_slips.status → 'active' (rolled back if a leg reset undoes their settlement)
//      Also resets legs_resolved/legs_won counters on any slip whose
//      state was advanced by the wrongful void.
//   3. Calls the standard /api/markets/resolve endpoint with the REAL
//      outcome(s). That path pays winners atomically via the same
//      settle_bet_outcome RPC used by every normal resolution, so
//      there's no bespoke crediting logic here to get wrong.
//
// Body:
//   { marketId, winningOutcomeIndices: number[], dryRun?: boolean }
//
// dryRun defaults TRUE and only prints the reconciliation plan.
//
// Preconditions:
//   - Market is currently 'voided' (any variant of the wrongful void).
//   - Admin has confirmed the real outcome(s) — pass them in.
//   - Market currently has bets OR legs to re-settle. Otherwise nothing
//     to do; caller should investigate why the market looks empty
//     before doing anything.

interface RefundedBet {
  id: string;
  user_id: string;
  net_stake_tngn: number;
  outcome_index: number;
  bonus_proportion: number | null;
}

export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const marketId = Number(body?.marketId);
    const dryRun = body?.dryRun !== false;

    const rawIndices: number[] = Array.isArray(body?.winningOutcomeIndices)
      ? body.winningOutcomeIndices.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n))
      : (body?.winningOutcomeIndex !== undefined && body?.winningOutcomeIndex !== null && Number.isInteger(Number(body.winningOutcomeIndex)))
        ? [Number(body.winningOutcomeIndex)]
        : [];
    const winningOutcomeIndices = Array.from(new Set(rawIndices)).sort((a, b) => a - b);

    if (!marketId || winningOutcomeIndices.length === 0) {
      return NextResponse.json({ error: 'Provide marketId and winningOutcomeIndices (array of integer indices).' }, { status: 400 });
    }

    const { data: market, error: mErr } = await supabaseAdmin
      .from('markets')
      .select('id, question, status, options, is_locked_odds')
      .eq('id', marketId)
      .single();
    if (mErr || !market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    if (market.status !== 'voided' && market.status !== 'pending_void') {
      return NextResponse.json({ error: `Only voided/pending_void markets can be re-resolved here. Market ${marketId} is ${market.status}.` }, { status: 400 });
    }
    const optionsLen = Array.isArray(market.options) ? market.options.length : 0;
    if (winningOutcomeIndices.some(i => i < 0 || i >= optionsLen)) {
      return NextResponse.json({ error: `winningOutcomeIndex out of range for this market's ${optionsLen} option(s).` }, { status: 400 });
    }

    // Refunded singles that need their refund clawed back.
    const { data: refundedBets, error: rbErr } = await supabaseAdmin
      .from('user_bets')
      .select('id, user_id, net_stake_tngn, outcome_index, bonus_proportion')
      .eq('market_id', marketId)
      .eq('status', 'refunded');
    if (rbErr) throw new Error(`refunded bets read: ${rbErr.message}`);

    // Multiplier legs on this market that still need to be settled.
    // Two shapes to handle:
    //   'void'   — legs were settled to 1.0x by the wrongful void path
    //              (needs reset back to 'active' before re-resolve)
    //   'active' — the more common shape: the wrongful void code path
    //              never called settle_multiplier_for_market at all,
    //              so the legs are still 'active'. Nothing to reset;
    //              the /api/markets/resolve pass will settle them.
    const { data: voidedLegs, error: vlErr } = await supabaseAdmin
      .from('multiplier_legs')
      .select('id, slip_id, outcome_index, locked_odds')
      .eq('market_id', marketId)
      .eq('status', 'void');
    if (vlErr) throw new Error(`voided legs read: ${vlErr.message}`);
    const { data: activeLegs, error: alErr } = await supabaseAdmin
      .from('multiplier_legs')
      .select('id, slip_id, outcome_index, locked_odds')
      .eq('market_id', marketId)
      .eq('status', 'active');
    if (alErr) throw new Error(`active legs read: ${alErr.message}`);

    // Slips that will need their state rolled back — only slips with a
    // VOIDED leg here need rollback (a leg that's already 'active' has
    // never been counted against the slip's legs_resolved, so there's
    // nothing to undo for it; settle_multiplier_for_market will pick it
    // up naturally once resolve() runs). We still fetch slips touching
    // activeLegs too, purely for the dry-run report.
    const voidedLegSlipIds = Array.from(new Set((voidedLegs || []).map(l => l.slip_id)));
    const activeLegSlipIds = Array.from(new Set((activeLegs || []).map(l => l.slip_id)));
    const allSlipIds = Array.from(new Set([...voidedLegSlipIds, ...activeLegSlipIds]));
    let allTouchedSlips: any[] = [];
    if (allSlipIds.length > 0) {
      const { data: slips, error: sErr } = await supabaseAdmin
        .from('multiplier_slips')
        .select('id, status, legs_resolved, legs_won, legs_total, final_payout_tngn, net_slip_stake_tngn, user_id, bonus_proportion')
        .in('id', allSlipIds);
      if (sErr) throw new Error(`slips read: ${sErr.message}`);
      allTouchedSlips = slips || [];
    }
    // Only the voided-leg subset actually gets rolled back below.
    const affectedSlips = allTouchedSlips.filter(s => voidedLegSlipIds.includes(s.id));

    if ((refundedBets?.length ?? 0) === 0 && (voidedLegs?.length ?? 0) === 0 && (activeLegs?.length ?? 0) === 0) {
      return NextResponse.json({
        error: `Market ${marketId} has no refunded singles and no multiplier legs (active or voided) to re-settle. Investigate the market state before re-resolving.`,
      }, { status: 400 });
    }

    const winningSet = new Set(winningOutcomeIndices);
    const winningRefunded = (refundedBets || []).filter((b: RefundedBet) => winningSet.has(b.outcome_index));
    const losingRefunded = (refundedBets || []).filter((b: RefundedBet) => !winningSet.has(b.outcome_index));
    const clawbackByUser: Record<string, number> = {};
    for (const b of refundedBets || []) {
      clawbackByUser[b.user_id] = (clawbackByUser[b.user_id] || 0) + Number(b.net_stake_tngn || 0);
    }

    const plan = {
      market: { id: market.id, question: market.question, isLockedOdds: market.is_locked_odds },
      winningOutcomeIndices,
      refundedBetCount: refundedBets?.length ?? 0,
      voidedLegCount: voidedLegs?.length ?? 0,
      affectedSlipCount: affectedSlips.length,
      winningRefundedCount: winningRefunded.length,
      losingRefundedCount: losingRefunded.length,
      totalClawbackTngn: Object.values(clawbackByUser).reduce((s, v) => s + v, 0),
      usersOwedClawback: Object.entries(clawbackByUser).map(([userId, amount]) => ({ userId, clawbackTngn: amount })),
    };

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        plan,
        note: 'DRY RUN — nothing changed. Re-POST with { dryRun: false } to apply. This will: (1) claw back the wrongful refund from each user\'s tngn_balance (clamped at 0 — see recoup-refunds shortfall note), (2) reset the market, bets, and multiplier legs to pre-resolution state, (3) call /api/markets/resolve with the real outcome so winners get paid at their proper odds and losers lose cleanly.',
      });
    }

    // ── APPLY ──────────────────────────────────────────────────────────

    // 1. Clawback the wrongful refunds. Using credit_user with negative
    //    delta — clamps at 0 so a user who already spent their refund
    //    just zeroes out rather than going negative (the same
    //    shortfall behavior recoup-refunds documents).
    let clawbackApplied = 0;
    for (const [userId, amount] of Object.entries(clawbackByUser)) {
      if (amount <= 0) continue;
      const { error: cErr } = await supabaseAdmin.rpc('credit_user', {
        p_user_id: userId,
        p_tngn_delta: -amount,
        p_bonus_delta: 0,
      });
      if (cErr) throw new Error(`clawback for user ${userId}: ${cErr.message}`);
      clawbackApplied += amount;
    }

    // 2a. Reset the refunded singles → active. The bet's next stop is
    //     the /api/markets/resolve pass below.
    if ((refundedBets?.length ?? 0) > 0) {
      const ids = (refundedBets || []).map(b => b.id);
      const { error: uErr } = await supabaseAdmin
        .from('user_bets')
        .update({ status: 'active', payout_tngn: null })
        .in('id', ids);
      if (uErr) throw new Error(`bet reset: ${uErr.message}`);
    }

    // 2b. Reset voided legs → active. Also roll back the parent slip's
    //     legs_resolved / legs_won counters if the wrongful void
    //     advanced them past its actual settlement state, and if the
    //     slip was already marked 'voided' AND paid, we need to claw
    //     back that payout too.
    if ((voidedLegs?.length ?? 0) > 0) {
      const legIds = (voidedLegs || []).map(l => l.id);
      const { error: lErr } = await supabaseAdmin
        .from('multiplier_legs')
        .update({ status: 'active', realized_odds: null, resolved_at: null })
        .in('id', legIds);
      if (lErr) throw new Error(`leg reset: ${lErr.message}`);
    }

    // 2c. For each affected slip: roll counters back by the number of
    //     legs we just reset on it, and if the slip is 'voided' (was
    //     paid via credit_user on the all-void path), claw back that
    //     stake refund AND the Boost that was returned to them.
    for (const slip of affectedSlips) {
      const legsResetOnThisSlip = (voidedLegs || []).filter(l => l.slip_id === slip.id).length;
      const newLegsResolved = Math.max(0, (slip.legs_resolved || 0) - legsResetOnThisSlip);
      const newLegsWon = Math.max(0, (slip.legs_won || 0) - 0); // reset legs were 'void', not 'won'

      if (slip.status === 'voided') {
        // All-void refund was paid. Claw back the stake credit split
        // in the same proportion the settle path used (net_slip_stake
        // × (1 - bonus_proportion) → tngn, rest → bonus).
        const netStake = Number(slip.net_slip_stake_tngn || 0);
        const bonusProp = Number(slip.bonus_proportion || 0);
        const tngnBack = Math.round(netStake * (1 - bonusProp) * 10000) / 10000;
        const bonusBack = netStake - tngnBack;
        if (netStake > 0) {
          const { error: cErr } = await supabaseAdmin.rpc('credit_user', {
            p_user_id: slip.user_id,
            p_tngn_delta: -tngnBack,
            p_bonus_delta: -bonusBack,
          });
          if (cErr) throw new Error(`slip clawback for slip ${slip.id}: ${cErr.message}`);
        }
        // Take back the refunded Boost — read + write pair mirroring the
        // credit direction settle_multiplier_for_market uses on the all-
        // void refund path. Not race-safe against concurrent boost
        // mutations, but this endpoint is admin-only and one-shot per
        // market so that's acceptable; if the user has 0 Boosts, clamp
        // rather than push negative.
        const { data: wallet } = await supabaseAdmin
          .from('boost_wallet')
          .select('balance')
          .eq('user_id', slip.user_id)
          .maybeSingle();
        const currentBoosts = Number(wallet?.balance || 0);
        if (currentBoosts > 0) {
          const newBoosts = currentBoosts - 1;
          await supabaseAdmin
            .from('boost_wallet')
            .update({ balance: newBoosts, updated_at: new Date().toISOString() })
            .eq('user_id', slip.user_id);
          await supabaseAdmin.from('boost_ledger').insert({
            user_id: slip.user_id,
            delta: -1,
            reason: 'void_reversal_clawback',
            slip_id: slip.id,
            balance_after: newBoosts,
          });
        }
      }

      await supabaseAdmin
        .from('multiplier_slips')
        .update({
          status: 'active',
          legs_resolved: newLegsResolved,
          legs_won: newLegsWon,
          final_payout_tngn: 0,
          settled_at: null,
        })
        .eq('id', slip.id);
    }

    // 3. Reset the market itself and re-run resolve.
    await supabaseAdmin.from('markets').update({
      status: 'locked',
      resolved_outcome: null,
      resolved_outcomes: null,
      void_reason: null,
      void_requested_at: null,
      resolved_at: null,
    }).eq('id', marketId);

    // Audit trail — one summary row before resolve fires so an operator
    // reading treasury_log can see exactly which markets were rerun
    // and when.
    await supabaseAdmin.from('treasury_log').insert({
      type: 'void_reversal',
      amount_tngn: clawbackApplied,
      market_id: marketId,
      metadata: {
        winning_outcome_indices: winningOutcomeIndices,
        refunded_bets_reset: refundedBets?.length ?? 0,
        voided_legs_reset: voidedLegs?.length ?? 0,
        slips_reopened: affectedSlips.length,
        total_clawback_tngn: clawbackApplied,
      },
      created_at: new Date().toISOString(),
    });

    // Call the resolve endpoint with the real outcome. The route now
    // handles multi-outcome + atomic per-bet settlement, so winners
    // will be paid at their true odds and losers lost cleanly.
    const baseUrl = getBaseUrl();
    const resolveRes = await fetch(`${baseUrl}/api/markets/resolve`, {
      method: 'POST',
      headers: cronHeaders(),
      body: JSON.stringify({ marketId, winningOutcomeIndices }),
    });
    const resolveBody = await resolveRes.json().catch(() => ({}));

    return NextResponse.json({
      dryRun: false,
      marketId,
      winningOutcomeIndices,
      clawbackApplied,
      resolveStatus: resolveRes.status,
      resolveResult: resolveBody,
      note: resolveRes.ok
        ? 'Re-resolve complete. Winners paid at their true odds via /api/markets/resolve, losers lost cleanly. Full audit in treasury_log.'
        : 'Void reversal applied but the final resolve call failed — market is now status=locked with reset bets/legs, safe to retry via the normal resolve UI/endpoint. See resolveResult.',
    });
  } catch (e: any) {
    console.error('re-resolve-voided-market crashed:', e);
    return NextResponse.json({ error: `Re-resolve failed: ${e?.message || String(e)}`, stack: (e?.stack || '').slice(0, 400) }, { status: 500 });
  }
}
