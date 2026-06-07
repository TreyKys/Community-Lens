import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Map Postgres exceptions thrown by place_bet() to HTTP responses.
// Keeping this list explicit so QA can grep for each.
function mapRpcError(message: string): { status: number; error: string } {
  if (message.includes('invalid_input'))          return { status: 400, error: 'Missing required fields' };
  if (message.includes('stake_below_minimum'))    return { status: 400, error: 'Minimum stake is ₦100 (100 tNGN)' };
  if (message.includes('invalid_outcome'))        return { status: 400, error: 'Invalid outcome selection' };
  if (message.includes('market_not_found'))       return { status: 404, error: 'Market not found' };
  if (message.includes('user_not_found'))         return { status: 404, error: 'User not found' };
  if (message.includes('market_not_open'))        return { status: 400, error: 'Market is not open for betting' };
  if (message.includes('market_closed'))          return { status: 400, error: 'Market betting period has ended' };
  if (message.includes('insufficient_balance'))   return { status: 400, error: 'Insufficient balance' };
  return { status: 500, error: 'Failed to place bet' };
}

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

    // Malformed JSON is a client problem, not a server one — return 400.
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 });
    }

    const { marketId, outcomeIndex, stakeAmount } = body || {};

    if (
      marketId === undefined || marketId === null ||
      outcomeIndex === undefined || outcomeIndex === null ||
      stakeAmount === undefined || stakeAmount === null
    ) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const stakeNum = Number(stakeAmount);
    const outcomeNum = Number(outcomeIndex);
    if (!Number.isFinite(stakeNum) || stakeNum <= 0 ||
        !Number.isInteger(outcomeNum) || outcomeNum < 0) {
      return NextResponse.json({ error: 'Invalid stake or outcome' }, { status: 400 });
    }

    // One atomic RPC call replaces the old 4-step read-then-write
    // sequence. Concurrency, race conditions, and balance integrity
    // are all handled in-database with row-level locks.
    const { data, error: rpcError } = await supabaseAdmin
      .rpc('place_bet', {
        p_user_id: user.id,
        p_market_id: marketId,
        p_outcome_index: outcomeNum,
        p_stake_tngn: stakeNum,
      })
      .single<{
        bet_id: string;
        net_stake: number;
        entry_rake: number;
        new_tngn_balance: number;
        new_bonus_balance: number;
        is_jackpot_eligible: boolean;
      }>();

    if (rpcError) {
      const mapped = mapRpcError(rpcError.message || '');
      if (mapped.status >= 500) {
        console.error('place_bet RPC failure:', rpcError);
      }
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }

    if (!data) {
      console.error('place_bet returned no row');
      return NextResponse.json({ error: 'Failed to place bet' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      betId: data.bet_id,
      stakeAmount: stakeNum,
      netStake: data.net_stake,
      entryRake: data.entry_rake,
      isJackpotEligible: data.is_jackpot_eligible,
      newBalance: data.new_tngn_balance,
      newBonusBalance: data.new_bonus_balance,
    }, { status: 200 });

  } catch (error: any) {
    console.error('Bet placement error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
