import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabaseAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-key"
);

// Entry Rake: 1.5% deducted from stake before it enters the pool
const ENTRY_RAKE = 0.015;

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await getSupabaseAdmin().auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const { marketId, outcomeIndex, stakeAmount } = await request.json();

    // Validate inputs
    if (!marketId || outcomeIndex === undefined || !stakeAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (stakeAmount < 100) {
      return NextResponse.json({ error: 'Minimum stake is ₦100 (100 tNGN)' }, { status: 400 });
    }

    // 1. Fetch user balance
    const { data: userData, error: userError } = await getSupabaseAdmin()
      .from('users')
      .select('tngn_balance, bonus_balance')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // 2. Check if user has sufficient balance
    // Use real balance first, then bonus balance
    const totalAvailable = (userData.tngn_balance || 0) + (userData.bonus_balance || 0);
    if (totalAvailable < stakeAmount) {
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
    }

    // 3. Fetch market and verify it's still open
    const { data: market, error: marketError } = await getSupabaseAdmin()
      .from('markets')
      .select('id, status, closes_at, options')
      .eq('id', marketId)
      .single();

    if (marketError || !market) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    if (market.status !== 'open') {
      return NextResponse.json({ error: 'Market is not open for betting' }, { status: 400 });
    }

    if (new Date(market.closes_at) < new Date()) {
      return NextResponse.json({ error: 'Market betting period has ended' }, { status: 400 });
    }

    // 4. Calculate rake
    const entryRakeAmount = stakeAmount * ENTRY_RAKE;
    const netStake = stakeAmount - entryRakeAmount;

    // 5. Determine if this qualifies for the jackpot
    // We check after the bet is placed — jackpot eligibility is tracked per slip
    // For now we record it and the jackpot engine evaluates at market lock
    const isJackpotEligible = stakeAmount >= 500;

    // 6. Deduct from balance (use real balance first, then bonus)
    let newRealBalance = userData.tngn_balance || 0;
    let newBonusBalance = userData.bonus_balance || 0;

    if (newRealBalance >= stakeAmount) {
      newRealBalance -= stakeAmount;
    } else {
      // Spend real balance first, then bonus
      const remainingAfterReal = stakeAmount - newRealBalance;
      newRealBalance = 0;
      newBonusBalance -= remainingAfterReal;
    }

    // 7. Write bet to database (this is the fast path — no blockchain)
    const { data: bet, error: betError } = await getSupabaseAdmin()
      .from('user_bets')
      .insert({
        user_id: user.id,
        market_id: marketId,
        outcome_index: outcomeIndex,
        stake_tngn: stakeAmount,
        net_stake_tngn: netStake,
        entry_rake_tngn: entryRakeAmount,
        is_jackpot_eligible: isJackpotEligible,
        placed_at: new Date().toISOString(),
        status: 'active',
      })
      .select('id')
      .single();

    if (betError) {
      console.error('Failed to write bet:', betError);
      return NextResponse.json({ error: 'Failed to place bet' }, { status: 500 });
    }

    // 8. Update user balance
    const { error: balanceError } = await getSupabaseAdmin()
      .from('users')
      .update({
        tngn_balance: newRealBalance,
        bonus_balance: Math.max(0, newBonusBalance),
      })
      .eq('id', user.id);

    if (balanceError) {
      console.error('Failed to update balance:', balanceError);
      // Critical: bet was written but balance not deducted — log for manual review
      await getSupabaseAdmin().from('error_log').insert({
        type: 'balance_deduction_failed',
        bet_id: bet.id,
        user_id: user.id,
        amount: stakeAmount,
        created_at: new Date().toISOString(),
      });
      return NextResponse.json({ error: 'Balance update failed' }, { status: 500 });
    }

    // 9. Record the rake in the treasury log
    await getSupabaseAdmin().from('treasury_log').insert({
      type: 'entry_rake',
      amount_tngn: entryRakeAmount,
      bet_id: bet.id,
      user_id: user.id,
      market_id: marketId,
      created_at: new Date().toISOString(),
    });

    console.log(`Bet placed: user=${user.id}, market=${marketId}, stake=${stakeAmount}, netStake=${netStake}, rake=${entryRakeAmount}`);

    return NextResponse.json({
      success: true,
      betId: bet.id,
      stakeAmount,
      netStake,
      entryRake: entryRakeAmount,
      isJackpotEligible,
      newBalance: newRealBalance,
    }, { status: 200 });

  } catch (error: any) {
    console.error('Bet placement error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
