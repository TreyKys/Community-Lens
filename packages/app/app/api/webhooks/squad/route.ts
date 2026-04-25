import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Match Paystack: 1.5% conversion spread to platform, 1% deposit promo to user.
const CONVERSION_SPREAD = 0.015;
const DEPOSIT_PROMO = 0.01;

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-squad-encrypted-body');
    const secret = process.env.SQUAD_SECRET_KEY;

    if (!secret || !signature) {
      return NextResponse.json({ error: 'Missing secret or signature' }, { status: 400 });
    }

    // Squad signs the raw body with HMAC-SHA512 keyed by the secret key (uppercase hex).
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex').toUpperCase();
    if (hash !== signature.toUpperCase()) {
      console.error('Squad signature verification failed.');
      return NextResponse.json({ error: 'Unauthorized payload' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    // Squad fires `transaction_notification` for inbound virtual-account credits.
    const event = payload.event || payload.Event;
    if (event && event !== 'transaction_notification' && event !== 'successful_transaction') {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const data = payload.data || payload;
    const transactionRef: string | undefined = data.transaction_reference || data.reference;
    const amountField = data.transaction_amount ?? data.amount; // major NGN units in Squad payload
    const accountNumber: string | undefined = data.virtual_account_number || data.account_number;

    if (!transactionRef || !amountField || !accountNumber) {
      return NextResponse.json({ error: 'Missing transaction fields' }, { status: 400 });
    }

    // Idempotency
    const { data: existingTx } = await supabaseAdmin
      .from('squad_transactions')
      .select('transaction_ref')
      .eq('transaction_ref', transactionRef)
      .single();

    if (existingTx) {
      return NextResponse.json({ status: 'already processed' }, { status: 200 });
    }

    // Map account → user
    const { data: vAccount } = await supabaseAdmin
      .from('squad_virtual_accounts')
      .select('user_id')
      .eq('account_number', accountNumber)
      .single();

    if (!vAccount) {
      console.error('Squad webhook: no virtual account found for', accountNumber);
      return NextResponse.json({ error: 'Account not provisioned' }, { status: 404 });
    }
    const userId = vAccount.user_id;

    const amountInNGN = Number(amountField);
    const spreadAmount = amountInNGN * CONVERSION_SPREAD;
    const tNGNToCredit = amountInNGN - spreadAmount;
    const betCredit = amountInNGN * DEPOSIT_PROMO;

    const { error: insertError } = await supabaseAdmin
      .from('squad_transactions')
      .insert({
        transaction_ref: transactionRef,
        user_id: userId,
        amount_ngn: amountInNGN,
        tngn_credited: tNGNToCredit,
        spread_captured: spreadAmount,
        status: 'pending',
        raw_payload: payload,
      });

    if (insertError) {
      console.error('Failed to insert squad transaction:', insertError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('tngn_balance, bonus_balance')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      await supabaseAdmin
        .from('squad_transactions')
        .update({ status: 'failed_user_not_found' })
        .eq('transaction_ref', transactionRef);
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        tngn_balance: (userData.tngn_balance || 0) + tNGNToCredit,
        bonus_balance: (userData.bonus_balance || 0) + betCredit,
      })
      .eq('id', userId);

    if (updateError) {
      await supabaseAdmin
        .from('squad_transactions')
        .update({ status: 'failed_balance_update' })
        .eq('transaction_ref', transactionRef);
      return NextResponse.json({ error: 'Failed to credit balance' }, { status: 500 });
    }

    await supabaseAdmin
      .from('squad_transactions')
      .update({ status: 'completed' })
      .eq('transaction_ref', transactionRef);

    await supabaseAdmin.from('treasury_log').insert([
      { type: 'deposit_spread', amount_tngn: spreadAmount, user_id: userId, metadata: { source: 'squad', transaction_ref: transactionRef } },
      { type: 'deposit_bet_credit', amount_tngn: -betCredit, user_id: userId, metadata: { source: 'squad', transaction_ref: transactionRef } },
    ]);

    return NextResponse.json({
      status: 'success',
      tNGNcredited: tNGNToCredit,
      spreadCaptured: spreadAmount,
      betCredit,
    }, { status: 200 });
  } catch (e: any) {
    console.error('Squad webhook error:', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
