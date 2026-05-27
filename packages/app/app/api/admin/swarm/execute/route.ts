import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ENTRY_RAKE = 0.015;

export async function POST(request: Request) {
  try {
    const isValidAdmin = isAdminRequest(request);
    if (!isValidAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { botId, marketId, outcomeIndex, stakeAmount } = await request.json();

    if (!botId || !marketId || outcomeIndex === undefined || !stakeAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Verify it's a bot
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('is_bot, tngn_balance, bonus_balance')
      .eq('id', botId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'Bot user not found' }, { status: 404 });
    }

    if (!user.is_bot) {
      return NextResponse.json({ error: 'User is not flagged as a bot' }, { status: 403 });
    }

    const entryRakeAmount = stakeAmount * ENTRY_RAKE;
    const isJackpotEligible = stakeAmount >= 500;

    // Use the RPC! Atomicity guaranteed.
    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('place_bet', {
      p_user_id: botId,
      p_market_id: marketId,
      p_outcome_index: outcomeIndex,
      p_stake_amount: stakeAmount,
      p_entry_rake: entryRakeAmount,
      p_is_jackpot_eligible: isJackpotEligible
    });

    if (rpcError) {
       return NextResponse.json({ error: 'Transaction failed', details: rpcError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, betData: rpcData }, { status: 200 });

  } catch (error: any) {
    console.error('Bot execute error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
