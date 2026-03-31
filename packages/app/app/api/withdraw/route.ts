import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://build-dummy.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'build-dummy-key'
);

// Fee structure
const WITHDRAWAL_SPREAD = 0.015;   // 1.5% conversion spread
const WITHDRAWAL_FLAT_FEE = 100;   // ₦100 flat fee
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

    if (amountTNGN < 1000) {
      return NextResponse.json({ error: 'Minimum withdrawal is 1,000 tNGN' }, { status: 400 });
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

    // 4. Check if this is a large withdrawal requiring manual approval
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
        status: isLargeWithdrawal ? 'pending_admin_approval' : 'pending_paystack',
        requires_admin_approval: isLargeWithdrawal,
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

    // 6. Large withdrawal: notify admin and return "under review" response
    if (isLargeWithdrawal) {
      // TODO: Send push/email notification to TreyKy here
      // e.g. via Resend, Novu, or a simple fetch to a webhook
      console.log(`LARGE WITHDRAWAL ALERT: user=${user.id}, amount=${amountTNGN} tNGN, withdrawal_id=${withdrawal.id}`);

      return NextResponse.json({
        status: 'under_review',
        message: 'Your withdrawal is being processed. Due to its size, it requires a security audit before release. This typically takes up to 24 hours. You will be notified once it clears.',
        withdrawalId: withdrawal.id,
        nairaToReceive: nairaToSend,
      }, { status: 200 });
    }

    // 7. Standard withdrawal: fire Paystack Transfer API
    // ---------------------------------------------------------------
    // PHASE 3 TODO: Uncomment and configure once Paystack live keys are ready.
    //
    // Step A: Create transfer recipient
    // const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
    //   method: 'POST',
    //   headers: {
    //     Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     type: 'nuban',
    //     name: accountName,
    //     account_number: accountNumber,
    //     bank_code: bankCode,
    //     currency: 'NGN',
    //   }),
    // });
    // const { data: recipient } = await recipientRes.json();
    //
    // Step B: Initiate transfer
    // const transferRes = await fetch('https://api.paystack.co/transfer', {
    //   method: 'POST',
    //   headers: {
    //     Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     source: 'balance',
    //     amount: nairaToSend * 100, // Paystack uses kobo
    //     recipient: recipient.recipient_code,
    //     reason: `TruthMarket withdrawal - ${withdrawal.id}`,
    //   }),
    // });
    // const { data: transfer } = await transferRes.json();
    //
    // await supabaseAdmin.from('withdrawals').update({
    //   status: 'completed',
    //   paystack_transfer_code: transfer.transfer_code,
    // }).eq('id', withdrawal.id);
    // ---------------------------------------------------------------

    // For now, mark as queued for manual Paystack processing
    await supabaseAdmin
      .from('withdrawals')
      .update({ status: 'queued_for_paystack' })
      .eq('id', withdrawal.id);

    console.log(`Withdrawal queued: user=${user.id}, tNGN=${amountTNGN}, NGN to send=${nairaToSend}`);

    return NextResponse.json({
      status: 'success',
      withdrawalId: withdrawal.id,
      amountTNGN,
      nairaToReceive: nairaToSend,
      feesDeducted: spreadAmount + WITHDRAWAL_FLAT_FEE,
      message: 'Withdrawal initiated. Funds will arrive in your bank account within 1-2 hours.',
    }, { status: 200 });

  } catch (error: any) {
    console.error('Withdrawal error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
