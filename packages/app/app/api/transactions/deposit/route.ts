import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy-for-build.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key';

export async function POST(req: NextRequest) {
  try {
    const { userId, amountNgn } = await req.json();

    if (!userId || !amountNgn || amountNgn <= 0) {
      return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Spread Economics Architecture: 1.5% conversion spread natively
    const CONVERSION_RATE = 0.985;
    const tngnToCredit = amountNgn * CONVERSION_RATE;

    // 1. Fetch user to update their balance
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, tngn_balance')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const newBalance = Number(user.tngn_balance) + tngnToCredit;

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
        type: 'deposit',
        amount: amountNgn, // Storing original fiat value
        currency: 'NGN',
        conversion_rate: CONVERSION_RATE,
        status: 'completed'
    });

    return NextResponse.json({
        success: true,
        tngnCredited: tngnToCredit,
        newBalance: newBalance
    }, { status: 200 });

  } catch (error: unknown) {
    console.error('Deposit error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
