import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy-for-build.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key';

export async function POST(req: NextRequest) {
  try {
    const { userId, amountTngn } = await req.json();

    if (!userId || !amountTngn || amountTngn <= 0) {
      return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Spread Economics Architecture: 1.5% conversion spread + ₦100 flat fee
    const CONVERSION_RATE = 0.985;
    const FLAT_FEE = 100;

    const nairaValue = amountTngn * CONVERSION_RATE;
    const netNairaToTransfer = nairaValue - FLAT_FEE;

    if (netNairaToTransfer <= 0) {
         return NextResponse.json({ error: 'Withdrawal amount too small to cover fees' }, { status: 400 });
    }

    // 1. Fetch user to update their balance
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, tngn_balance')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (Number(user.tngn_balance) < amountTngn) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
    }

    const newBalance = Number(user.tngn_balance) - amountTngn;

    // 2. Update Balance
    const { error: updateError } = await supabase
      .from('users')
      .update({ tngn_balance: newBalance })
      .eq('id', userId)
      .eq('tngn_balance', user.tngn_balance); // optimistic locking

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update balance' }, { status: 500 });
    }

    // 3. Log Transaction
    await supabase.from('transactions').insert({
        user_id: userId,
        type: 'withdraw',
        amount: amountTngn,
        currency: 'tNGN',
        conversion_rate: CONVERSION_RATE,
        status: 'completed'
    });

    // In a real application, we would call the Paystack Transfer API here
    // to actually send `netNairaToTransfer` NGN to the user's bank account.

    return NextResponse.json({
        success: true,
        netNaira: netNairaToTransfer,
        newBalance: newBalance
    }, { status: 200 });

  } catch (error: unknown) {
    console.error('Withdrawal error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
