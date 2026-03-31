import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://build-dummy.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'build-dummy-key'
);

const RESOLUTION_RAKE = 0.05; // 5% of the losing (profit) pool

export async function POST(request: Request) {
  try {
    // Only callable by the oracle bot or admin
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { marketId, winningOutcomeIndex } = await request.json();

    if (!marketId || winningOutcomeIndex === undefined) {
      return NextResponse.json({ error: 'Missing marketId or winningOutcomeIndex' }, { status: 400 });
    }

    // 1. Fetch market
    const { data: market, error: marketError } = await supabaseAdmin
      .from('markets')
      .select('*')
      .eq('id', marketId)
      .single();

    if (marketError || !market) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    if (market.status !== 'locked') {
      return NextResponse.json({ error: 'Market must be locked before resolving' }, { status: 400 });
    }

    // 2. Fetch all active bets for this market
    const { data: bets, error: betsError } = await supabaseAdmin
      .from('user_bets')
      .select('id, user_id, outcome_index, net_stake_tngn')
      .eq('market_id', marketId)
      .eq('status', 'active');

    if (betsError) {
      return NextResponse.json({ error: 'Failed to fetch bets' }, { status: 500 });
    }

    if (!bets || bets.length === 0) {
      // No bets — void the market
      await supabaseAdmin
        .from('markets')
        .update({ status: 'voided', resolved_outcome: null })
        .eq('id', marketId);
      return NextResponse.json({ status: 'voided', reason: 'No bets placed' });
    }

    // 3. Calculate pools
    const winningBets = bets.filter((b) => b.outcome_index === winningOutcomeIndex);
    const losingBets = bets.filter((b) => b.outcome_index !== winningOutcomeIndex);

    const winningPool = winningBets.reduce((sum, b) => sum + b.net_stake_tngn, 0);
    const losingPool = losingBets.reduce((sum, b) => sum + b.net_stake_tngn, 0);
    const totalPool = winningPool + losingPool;

    // Handle edge cases: everyone bet the same side
    if (winningPool === 0 || losingPool === 0) {
      // Void and refund all bets
      for (const bet of bets) {
        const { data: userData } = await supabaseAdmin
          .from('users')
          .select('tngn_balance')
          .eq('id', bet.user_id)
          .single();

        if (userData) {
          await supabaseAdmin
            .from('users')
            .update({ tngn_balance: (userData.tngn_balance || 0) + bet.net_stake_tngn })
            .eq('id', bet.user_id);
        }

        await supabaseAdmin
          .from('user_bets')
          .update({ status: 'refunded' })
          .eq('id', bet.id);
      }

      await supabaseAdmin
        .from('markets')
        .update({ status: 'voided', resolved_outcome: winningOutcomeIndex })
        .eq('id', marketId);

      return NextResponse.json({ status: 'voided', reason: 'No losers — all bets refunded' });
    }

    // 4. Apply Resolution Rake on losing pool
    const resolutionRakeAmount = losingPool * RESOLUTION_RAKE;
    const payoutPool = totalPool - resolutionRakeAmount; // what winners share

    // 5. Distribute winnings to each winner proportionally
    const payouts: { userId: string; payout: number }[] = [];

    for (const bet of winningBets) {
      // payout = bet's share of winning pool × total payout pool
      const share = bet.net_stake_tngn / winningPool;
      const payout = share * payoutPool;
      payouts.push({ userId: bet.user_id, payout });

      // Credit the user's balance
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('tngn_balance')
        .eq('id', bet.user_id)
        .single();

      if (userData) {
        await supabaseAdmin
          .from('users')
          .update({ tngn_balance: (userData.tngn_balance || 0) + payout })
          .eq('id', bet.user_id);
      }

      await supabaseAdmin
        .from('user_bets')
        .update({ status: 'won', payout_tngn: payout })
        .eq('id', bet.id);
    }

    // 6. Mark losing bets as lost
    for (const bet of losingBets) {
      await supabaseAdmin
        .from('user_bets')
        .update({ status: 'lost', payout_tngn: 0 })
        .eq('id', bet.id);
    }

    // 7. Log the resolution rake to treasury
    await supabaseAdmin.from('treasury_log').insert({
      type: 'resolution_rake',
      amount_tngn: resolutionRakeAmount,
      market_id: marketId,
      created_at: new Date().toISOString(),
    });

    // 8. Mark market as resolved
    await supabaseAdmin
      .from('markets')
      .update({
        status: 'resolved',
        resolved_outcome: winningOutcomeIndex,
        total_pool: totalPool,
      })
      .eq('id', marketId);

    console.log(`Market ${marketId} resolved. Winner: outcome ${winningOutcomeIndex}. Pool: ${totalPool}. Rake: ${resolutionRakeAmount}. Payouts: ${payouts.length} winners.`);

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
    }, { status: 200 });

  } catch (error: any) {
    console.error('Market resolution error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
