import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Map place_multiplier_slip exceptions to HTTP. Explicit so QA can grep.
function mapSlipError(message: string): { status: number; error: string } {
  if (message.includes('invalid_input'))        return { status: 400, error: 'Missing or malformed slip' };
  if (message.includes('stake_below_min'))      return { status: 400, error: 'Minimum slip stake is ₦100' };
  if (message.includes('too_few_legs'))         return { status: 400, error: 'A Multiplier needs at least 2 picks' };
  if (message.includes('too_many_legs'))        return { status: 400, error: 'Too many picks for this stake' };
  if (message.includes('duplicate_event'))      return { status: 400, error: 'Only one pick per event' };
  if (message.includes('leg_below_min_odds'))   return { status: 400, error: 'One of your picks is too short-priced for a Multiplier' };
  if (message.includes('combined_below_min'))   return { status: 400, error: 'Combined odds must be at least 3.0×' };
  if (message.includes('leg_not_locked_odds'))  return { status: 400, error: 'One of your picks isn’t eligible for Multipliers' };
  if (message.includes('leg_not_open'))         return { status: 400, error: 'One of your picks has closed' };
  if (message.includes('leg_closed'))           return { status: 400, error: 'One of your picks has closed' };
  if (message.includes('leg_paused'))           return { status: 503, error: 'One of your picks is temporarily paused' };
  if (message.includes('market_not_found'))     return { status: 404, error: 'A selected market no longer exists' };
  if (message.includes('invalid_leg'))          return { status: 400, error: 'A pick is invalid' };
  if (message.includes('no_boosts'))            return { status: 402, error: 'You’re out of Boosts. Earn or buy more to place a Multiplier.' };
  if (message.includes('insufficient_balance')) return { status: 400, error: 'Insufficient balance' };
  if (message.includes('user_not_found'))       return { status: 404, error: 'User not found' };
  if (message.includes('reserve_unavailable'))  return { status: 503, error: 'Multiplier pricing temporarily unavailable' };
  return { status: 500, error: 'Failed to place Multiplier' };
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    let body: any;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Malformed request body' }, { status: 400 }); }

    const slipStake = Number(body?.slipStake);
    const legs = Array.isArray(body?.legs) ? body.legs : null;

    if (!Number.isFinite(slipStake) || slipStake <= 0 || !legs) {
      return NextResponse.json({ error: 'slipStake and legs are required' }, { status: 400 });
    }

    // Normalise legs to the jsonb shape the RPC expects, validating
    // each entry's shape here so a malformed leg returns a clean 400.
    const normalized = [];
    for (const l of legs) {
      const marketId = Number(l?.marketId);
      const outcomeIndex = Number(l?.outcomeIndex);
      if (!Number.isInteger(marketId) || marketId <= 0 ||
          !Number.isInteger(outcomeIndex) || outcomeIndex < 0) {
        return NextResponse.json({ error: 'Each leg needs a valid marketId and outcomeIndex' }, { status: 400 });
      }
      normalized.push({ market_id: marketId, outcome_index: outcomeIndex });
    }

    // Apply the daily Boost recharge before checking the balance.
    // recharge_boosts is a no-op when not yet due, but without this call
    // a user whose recharge IS due — but who hasn't opened the Boost UI
    // (which is the only other place recharge runs) — would be told
    // "no Boosts" and blocked from placing a slip they're actually
    // entitled to place. Idempotent and cheap.
    try {
      await supabaseAdmin.rpc('recharge_boosts', { p_user_id: user.id });
    } catch (e) {
      // Non-fatal: if recharge errors, placement still runs and the
      // boost check inside place_multiplier_slip is the real gate.
      console.error('recharge_boosts (pre-slip) failed:', e);
    }

    const { data, error } = await supabaseAdmin
      .rpc('place_multiplier_slip', {
        p_user_id: user.id,
        p_slip_stake: slipStake,
        p_legs: normalized,
      })
      .single<{
        slip_id: string;
        combined_odds: number;
        effective_combined_odds: number;
        net_slip_stake: number;
        payout_tngn: number;
        tier: number;
        boosts_remaining: number;
        new_tngn_balance: number;
        new_bonus_balance: number;
      }>();

    if (error) {
      const mapped = mapSlipError(error.message || '');
      if (mapped.status >= 500) console.error('place_multiplier_slip failure:', error);
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    if (!data) return NextResponse.json({ error: 'Failed to place Multiplier' }, { status: 500 });

    return NextResponse.json({
      success: true,
      slipId: data.slip_id,
      combinedOdds: data.effective_combined_odds,
      payout: data.payout_tngn,
      boostsRemaining: data.boosts_remaining,
      newBalance: data.new_tngn_balance,
      newBonusBalance: data.new_bonus_balance,
    }, { status: 200 });
  } catch (e: any) {
    console.error('Multiplier slip error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
