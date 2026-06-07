import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

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
const FIRST_BET_INSURANCE_CAP = 2000;

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

  const refundAmount = Math.min(bet.stake_tngn, FIRST_BET_INSURANCE_CAP);

  const { data: user } = await supabaseAdmin.from('users').select('bonus_balance').eq('id', userId).single();
  await supabaseAdmin.from('users').update({
    bonus_balance: (user?.bonus_balance || 0) + refundAmount,
  }).eq('id', userId);

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

    // Void if no losers or no winners
    if (winningPool === 0 || losingPool === 0) {
      for (const bet of bets) {
        const { data: u } = await supabaseAdmin.from('users').select('tngn_balance').eq('id', bet.user_id).single();
        if (u) await supabaseAdmin.from('users').update({ tngn_balance: (u.tngn_balance || 0) + bet.net_stake_tngn }).eq('id', bet.user_id);
        await supabaseAdmin.from('user_bets').update({ status: 'refunded' }).eq('id', bet.id);
      }
      await supabaseAdmin.from('markets').update({ status: 'voided', resolved_outcome: winningOutcomeIndex }).eq('id', marketId);
      return NextResponse.json({ status: 'voided', reason: 'No losers — all bets refunded' });
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

    // Pay winners + award win points
    for (const bet of winningBets) {
      const share = bet.net_stake_tngn / winningPool;
      const payout = share * payoutPool;
      const { data: u } = await supabaseAdmin.from('users').select('tngn_balance').eq('id', bet.user_id).single();
      if (u) await supabaseAdmin.from('users').update({ tngn_balance: (u.tngn_balance || 0) + payout }).eq('id', bet.user_id);
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
          p_metadata: { payout, profit },
        });
      }

      try {
        await supabaseAdmin.from('notifications').insert({
          user_id: bet.user_id,
          type: 'bet_won',
          message: `You won! ₦${payout.toLocaleString()} has been credited to your account. 🎉`,
          amount: payout,
        });
      } catch (err) {
        // non-critical
      }
    }

    // Mark losers + apply Random Bet Insurance + route VIP rake share
    for (const bet of losingBets) {
      await supabaseAdmin.from('user_bets').update({ status: 'lost', payout_tngn: 0 }).eq('id', bet.id);
      await applyFirstBetInsurance(bet.user_id, bet, marketId);

      // This bet's pro-rata share of the gross rake.
      const betRakeContribution = (bet.net_stake_tngn / totalPool) * grossRake;

      const ref = referrerByUser[bet.user_id];
      if (ref && ref.sharePct > 0 && betRakeContribution > 0) {
        const vipCut = betRakeContribution * (ref.sharePct / 100);
        if (vipCut > 0) {
          const { data: vu } = await supabaseAdmin
            .from('users')
            .select('bonus_balance')
            .eq('id', ref.vipId)
            .single();
          await supabaseAdmin
            .from('users')
            .update({ bonus_balance: (vu?.bonus_balance || 0) + vipCut })
            .eq('id', ref.vipId);
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
