import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Fee structure
const WITHDRAWAL_SPREAD = 0.01;    // 1% conversion spread
const WITHDRAWAL_FLAT_FEE = 50;    // ₦50 flat fee (covers gateway transfer cost)
const MIN_WITHDRAWAL_TNGN = 200;   // ₦200 floor
// Large withdrawal threshold — routes to manual admin approval
const LARGE_WITHDRAWAL_THRESHOLD = 500000; // ₦500,000 in tNGN

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

    const { amountTNGN, bankCode, accountNumber, accountName } = await request.json();

    if (!amountTNGN || !bankCode || !accountNumber) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (amountTNGN < MIN_WITHDRAWAL_TNGN) {
      return NextResponse.json({ error: `Minimum withdrawal is ₦${MIN_WITHDRAWAL_TNGN}` }, { status: 400 });
    }

    // 1. Fetch user balance (only real tNGN can be withdrawn — not bonus)
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('tngn_balance')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if ((userData.tngn_balance || 0) < amountTNGN) {
      return NextResponse.json({ error: 'Insufficient withdrawable balance' }, { status: 400 });
    }

    // 2. Calculate what user receives
    const spreadAmount = amountTNGN * WITHDRAWAL_SPREAD;
    const nairaAfterSpread = amountTNGN - spreadAmount;
    const nairaToSend = nairaAfterSpread - WITHDRAWAL_FLAT_FEE;

    if (nairaToSend <= 0) {
      return NextResponse.json({ error: 'Amount too small after fees' }, { status: 400 });
    }

    // 3. Deduct balance immediately (hold it while withdrawal processes)
    const newBalance = (userData.tngn_balance || 0) - amountTNGN;
    await supabaseAdmin
      .from('users')
      .update({ tngn_balance: newBalance })
      .eq('id', user.id);

    // 4. Flag large withdrawals for an extra security audit on the admin side.
    //    All withdrawals route through admin approval so ops can pick the
    //    gateway with the most headroom (Paystack vs Squad treasury balances).
    const isLargeWithdrawal = amountTNGN >= LARGE_WITHDRAWAL_THRESHOLD;

    // 5. Create withdrawal record
    const { data: withdrawal, error: wdError } = await supabaseAdmin
      .from('withdrawals')
      .insert({
        user_id: user.id,
        amount_tngn: amountTNGN,
        spread_amount: spreadAmount,
        flat_fee: WITHDRAWAL_FLAT_FEE,
        naira_to_send: nairaToSend,
        bank_code: bankCode,
        account_number: accountNumber,
        account_name: accountName || null,
        status: 'pending_admin_approval',
        gateway: null,                                  // admin picks at approval time
        requires_admin_approval: true,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (wdError) {
      // Refund balance if we couldn't create the record
      await supabaseAdmin
        .from('users')
        .update({ tngn_balance: userData.tngn_balance })
        .eq('id', user.id);
      return NextResponse.json({ error: 'Failed to create withdrawal request' }, { status: 500 });
    }

    // 6. Log fee capture as a treasury movement (no gateway yet — set on payout).
    await supabaseAdmin.from('treasury_movements').insert({
      user_id: user.id,
      type: 'spread',
      gateway: null,
      direction: 'in',
      amount_ngn: spreadAmount + WITHDRAWAL_FLAT_FEE,
      reference: withdrawal.id,
      metadata: { source: 'withdrawal_fee' },
    });

    console.log(`Withdrawal queued: user=${user.id}, tNGN=${amountTNGN}, NGN to send=${nairaToSend}, large=${isLargeWithdrawal}`);

    return NextResponse.json({
      status: 'under_review',
      withdrawalId: withdrawal.id,
      amountTNGN,
      nairaToReceive: nairaToSend,
      feesDeducted: spreadAmount + WITHDRAWAL_FLAT_FEE,
      message: isLargeWithdrawal
        ? 'Your withdrawal is being processed. Due to its size, it requires a security audit before release. This typically takes up to 24 hours.'
        : 'Withdrawal received. Our team will release it to your bank shortly — usually within 1-2 hours during business hours.',
    }, { status: 200 });

  } catch (error: any) {
    console.error('Withdrawal error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
