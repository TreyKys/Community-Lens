import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Map Postgres exceptions thrown by place_bet() / place_bet_locked()
// to HTTP responses. Keeping this list explicit so QA can grep for each.
function mapRpcError(message: string): { status: number; error: string } {
  if (message.includes('invalid_input'))            return { status: 400, error: 'Missing required fields' };
  if (message.includes('stake_below_minimum'))      return { status: 400, error: 'Minimum stake is ₦100 (100 tNGN)' };
  if (message.includes('invalid_outcome'))          return { status: 400, error: 'Invalid outcome selection' };
  if (message.includes('market_not_found'))         return { status: 404, error: 'Market not found' };
  if (message.includes('user_not_found'))           return { status: 404, error: 'User not found' };
  if (message.includes('market_not_open'))          return { status: 400, error: 'Market is not open for betting' };
  if (message.includes('market_closed'))            return { status: 400, error: 'Market betting period has ended' };
  if (message.includes('market_paused'))            return { status: 503, error: 'This market is temporarily paused' };
  if (message.includes('insufficient_balance'))     return { status: 400, error: 'Insufficient balance' };
  if (message.includes('market_not_locked_odds'))   return { status: 409, error: 'Pricing engine mismatch — please refresh and try again' };
  if (message.includes('liability_ceiling_breach')) return { status: 409, error: 'This market is at maximum exposure — try a smaller stake or a different market' };
  if (message.includes('reserve_unavailable'))      return { status: 503, error: 'Pricing engine temporarily unavailable' };
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

    // Tier-routing decision. We read the per-market is_locked_odds flag
    // up front and pick the right RPC. The flag is a small projection
    // off markets — cheap to fetch and lets us keep two atomic RPCs
    // each owning a single settlement model, rather than one giant
    // RPC with two code paths.
    //
    // Race condition handling: the RPC re-reads + row-locks the
    // market inside its own transaction, so even if an admin flips
    // the flag between this fetch and the RPC call, the RPC's
    // internal check (market_not_locked_odds for place_bet_locked,
    // implicit for place_bet) catches it and we surface a clean
    // 409 to the client to refresh and retry.
    const { data: market, error: marketLookupError } = await supabaseAdmin
      .from('markets')
      .select('id, is_locked_odds')
      .eq('id', marketId)
      .maybeSingle();

    if (marketLookupError) {
      console.error('Market lookup failed:', marketLookupError);
      return NextResponse.json({ error: 'Failed to place bet' }, { status: 500 });
    }
    if (!market) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    const isLockedOdds = !!market.is_locked_odds;

    // One atomic RPC call replaces the old 4-step read-then-write
    // sequence. Concurrency, race conditions, and balance integrity
    // are all handled in-database with row-level locks.
    if (isLockedOdds) {
      const { data, error: rpcError } = await supabaseAdmin
        .rpc('place_bet_locked', {
          p_user_id: user.id,
          p_market_id: marketId,
          p_outcome_index: outcomeNum,
          p_stake_tngn: stakeNum,
        })
        .single<{
          bet_id: string;
          locked_odds: number;
          net_stake: number;
          entry_rake: number;
          vig_at_stake_pct: number;
          tier: number;
          floor_payout: number;
          upper_payout: number;
          new_tngn_balance: number;
          new_bonus_balance: number;
          is_jackpot_eligible: boolean;
        }>();

      if (rpcError) {
        const mapped = mapRpcError(rpcError.message || '');
        if (mapped.status >= 500) {
          console.error('place_bet_locked RPC failure:', rpcError);
        }
        return NextResponse.json({ error: mapped.error }, { status: mapped.status });
      }

      if (!data) {
        console.error('place_bet_locked returned no row');
        return NextResponse.json({ error: 'Failed to place bet' }, { status: 500 });
      }

      // The locked-odds response carries extra fields the modal needs
      // for the confirmation receipt. The tier is NOT exposed to the
      // user-facing UI — it's there for analytics/debugging only.
      return NextResponse.json({
        success: true,
        betId: data.bet_id,
        stakeAmount: stakeNum,
        netStake: data.net_stake,
        entryRake: data.entry_rake,
        lockedOdds: data.locked_odds,
        floorPayout: data.floor_payout,
        upperPayout: data.upper_payout,
        isJackpotEligible: data.is_jackpot_eligible,
        newBalance: data.new_tngn_balance,
        newBonusBalance: data.new_bonus_balance,
      }, { status: 200 });
    }

    // Parimutuel path — unchanged. This is what every existing market
    // (is_locked_odds = false, the default) continues to use.
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
