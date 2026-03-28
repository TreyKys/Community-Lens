import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy-for-build.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key';

export async function POST(req: NextRequest) {
  try {
    const { userId, marketId, outcome, amount } = await req.json();

    if (!userId || !marketId || !outcome || amount <= 0) {
      return NextResponse.json({ error: 'Missing required parameters or invalid amount' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Read user balance
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, tngn_balance, is_custodial')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.tngn_balance < amount) {
      return NextResponse.json({ error: 'Insufficient tNGN balance' }, { status: 400 });
    }

    // 2. Fetch the market to verify it's open
    const { data: market, error: marketError } = await supabase
      .from('markets')
      .select('id, status, closes_at')
      .eq('id', marketId)
      .single();

    if (marketError || !market) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    if (market.status !== 'open' || new Date(market.closes_at) <= new Date()) {
      return NextResponse.json({ error: 'Market is closed' }, { status: 400 });
    }

    // 3. Begin transaction-like sequence (Supabase REST lacks standard transactions, so we update cautiously)
    const newBalance = user.tngn_balance - amount;

    // Deduct balance
    const { error: updateError } = await supabase
      .from('users')
      .update({ tngn_balance: newBalance })
      .eq('id', userId)
      .eq('tngn_balance', user.tngn_balance); // Optimistic locking

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update balance. Try again.' }, { status: 500 });
    }

    // Write bet
    const { data: bet, error: betError } = await supabase
      .from('user_bets')
      .insert({
        user_id: userId,
        market_id: marketId,
        outcome,
        staked_amount: amount,
        status: 'pending'
      })
      .select()
      .single();

    if (betError) {
      // Rollback balance if bet insertion failed
      await supabase
        .from('users')
        .update({ tngn_balance: user.tngn_balance })
        .eq('id', userId);

      return NextResponse.json({ error: 'Failed to record bet' }, { status: 500 });
    }

    // Log transaction
    await supabase.from('transactions').insert({
        user_id: userId,
        type: 'bet_placed',
        amount: amount,
        currency: 'tNGN',
        status: 'completed'
    });

    return NextResponse.json({ success: true, bet, newBalance }, { status: 200 });

  } catch (error: unknown) {
    console.error('Error placing bet:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
