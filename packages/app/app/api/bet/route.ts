import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
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
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
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

    // Calculate rake
    const entryRakeAmount = stakeAmount * ENTRY_RAKE;
    const netStake = stakeAmount - entryRakeAmount;

    // Determine if this qualifies for the jackpot
    const isJackpotEligible = stakeAmount >= 500;

    // Use the RPC function for atomic bet placement
    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('place_bet', {
      p_user_id: user.id,
      p_market_id: marketId,
      p_outcome_index: outcomeIndex,
      p_stake_amount: stakeAmount,
      p_entry_rake: entryRakeAmount,
      p_is_jackpot_eligible: isJackpotEligible
    });

    if (rpcError) {
      console.error('Failed to write bet via RPC:', rpcError);

      // Map RPC errors to user-friendly messages
      let errorMessage = 'Failed to place bet';
      if (rpcError.message.includes('Insufficient balance')) {
        errorMessage = 'Insufficient balance';
      } else if (rpcError.message.includes('Market not found')) {
        errorMessage = 'Market not found';
      } else if (rpcError.message.includes('Market is not open')) {
        errorMessage = 'Market is not open for betting';
      } else if (rpcError.message.includes('Market betting period has ended')) {
        errorMessage = 'Market betting period has ended';
      } else if (rpcError.message.includes('User not found')) {
        errorMessage = 'User not found';
      }

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    console.log(`Bet placed via RPC: user=${user.id}, market=${marketId}, stake=${stakeAmount}, netStake=${netStake}, rake=${entryRakeAmount}`);

    return NextResponse.json({
      success: true,
      betId: rpcData.bet_id,
      stakeAmount,
      netStake,
      entryRake: entryRakeAmount,
      isJackpotEligible,
      newBalance: rpcData.new_tngn_balance,
    }, { status: 200 });

  } catch (error: any) {
    console.error('Bet placement error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
