import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const RESOLUTION_RAKE = 0.05;
const FIRST_BET_INSURANCE_CAP = 2000;

async function applyFirstBetInsurance(userId: string, bet: any) {
  // Only applies if: this is the user's very first resolved bet AND it was a loss
  const { count } = await supabaseAdmin
    .from('user_bets')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['won', 'lost']);

  // count will be 1 at this point — the bet we just marked as lost
  if (count !== 1) return;

  // Check not already refunded
  const { data: alreadyRefunded } = await supabaseAdmin
    .from('user_bets')
    .select('id')
    .eq('user_id', userId)
    .eq('is_first_bet_refunded', true)
    .single();

  if (alreadyRefunded) return;

  const refundAmount = Math.min(bet.stake_tngn, FIRST_BET_INSURANCE_CAP);

  // Credit bonus_balance (the spendable bonus column).
  const { data: user } = await supabaseAdmin.from('users').select('bonus_balance').eq('id', userId).single();
  await supabaseAdmin.from('users').update({
    bonus_balance: (user?.bonus_balance || 0) + refundAmount,
  }).eq('id', userId);

  // Flag the bet
  await supabaseAdmin.from('user_bets').update({ is_first_bet_refunded: true }).eq('id', bet.id);

  // Fire notification
  await supabaseAdmin.from('notifications').insert({
    user_id: userId,
    type: 'first_bet_refund',
    message: `Tough break! Your first bet is insured. ₦${refundAmount.toLocaleString()} has been added to your bonus balance. 🛡`,
    amount: refundAmount,
  });

  // Log to treasury
  await supabaseAdmin.from('treasury_log').insert({
    type: 'first_bet_insurance',
    amount_tngn: refundAmount,
    bet_id: bet.id,
    user_id: userId,
    metadata: { source: 'first_bet_insurance' },
    created_at: new Date().toISOString(),
  });

  console.log(`First Bet Insurance: user=${userId} refund=${refundAmount} tNGN`);
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

    const resolutionRakeAmount = losingPool * RESOLUTION_RAKE;
    const payoutPool = totalPool - resolutionRakeAmount;

    // Pay winners
    for (const bet of winningBets) {
      const share = bet.net_stake_tngn / winningPool;
      const payout = share * payoutPool;
      const { data: u } = await supabaseAdmin.from('users').select('tngn_balance').eq('id', bet.user_id).single();
      if (u) await supabaseAdmin.from('users').update({ tngn_balance: (u.tngn_balance || 0) + payout }).eq('id', bet.user_id);
      await supabaseAdmin.from('user_bets').update({ status: 'won', payout_tngn: payout }).eq('id', bet.id);
      // Win notification
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

    // Mark losers + apply First Bet Insurance
    for (const bet of losingBets) {
      await supabaseAdmin.from('user_bets').update({ status: 'lost', payout_tngn: 0 }).eq('id', bet.id);
      await applyFirstBetInsurance(bet.user_id, bet);
    }

    // Resolution rake to treasury
    await supabaseAdmin.from('treasury_log').insert({
      type: 'resolution_rake',
      amount_tngn: resolutionRakeAmount,
      market_id: marketId,
      created_at: new Date().toISOString(),
    });

    await supabaseAdmin.from('markets').update({
      status: 'resolved',
      resolved_outcome: winningOutcomeIndex,
      total_pool: totalPool,
    }).eq('id', marketId);

    console.log(`Market ${marketId} resolved. Winners: ${winningBets.length}. Pool: ${totalPool}. Rake: ${resolutionRakeAmount}.`);

    return NextResponse.json({
      success: true,
      marketId,
      winningOutcomeIndex,
      totalPool,
      winningPool,
      losingPool,
      resolutionRake: resolutionRakeAmount,
      payoutPool,
      winnersCount: winningBets.length,
      losersCount: losingBets.length,
    }, { status: 200 });

  } catch (error: any) {
    console.error('Market resolution error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
