import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Service role bypasses RLS — only used server-side, never exposed to client
const getSupabaseAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://mock.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-key"
);

// Conversion spread: we credit 98.5% of received amount as tNGN.
// The 1.5% goes to platform treasury. This is invisible to the user.
const CONVERSION_SPREAD = 0.015;

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-paystack-signature');
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret || !signature) {
      return NextResponse.json({ error: 'Missing secret or signature' }, { status: 400 });
    }

    // 1. Verify Paystack HMAC signature
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (hash !== signature) {
      console.error('Paystack signature verification failed.');
      return NextResponse.json({ error: 'Unauthorized payload' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    // Only process successful charges
    if (payload.event !== 'charge.success') {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const { reference, amount, metadata } = payload.data;

    // We expect the Supabase user ID in Paystack metadata
    const userId = metadata?.userId;
    if (!userId) {
      console.error('Missing userId in Paystack metadata.');
      return NextResponse.json({ error: 'Missing userId in metadata' }, { status: 400 });
    }

    // 2. Idempotency check — prevent double-crediting on webhook replays
    const { data: existingTx } = await getSupabaseAdmin()
      .from('paystack_transactions')
      .select('reference')
      .eq('reference', reference)
      .single();

    if (existingTx) {
      console.log(`Reference ${reference} already processed. Skipping.`);
      return NextResponse.json({ status: 'already processed' }, { status: 200 });
    }

    // amount from Paystack is in kobo (smallest unit)
    const amountInNGN = amount / 100;

    // Apply 1.5% conversion spread
    const spreadAmount = amountInNGN * CONVERSION_SPREAD;
    const tNGNToCredit = amountInNGN - spreadAmount; // what user receives

    // 3. Mark transaction as pending to prevent race conditions
    const { error: insertError } = await getSupabaseAdmin()
      .from('paystack_transactions')
      .insert({
        reference,
        user_id: userId,
        amount_ngn: amountInNGN,
        tngn_credited: tNGNToCredit,
        spread_captured: spreadAmount,
        status: 'pending',
        created_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error('Failed to insert transaction:', insertError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    // 4. Credit user's tNGN balance in Supabase (atomic increment)
    // NOTE: No blockchain transaction here. Supabase IS the source of truth.
    // The Master Protocol Wallet's on-chain tNGN supply is reconciled separately
    // via the treasury dashboard (Phase 3 admin panel).
    const { data: userData, error: userError } = await getSupabaseAdmin()
      .from('users')
      .select('tngn_balance')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      console.error('User not found for deposit:', userId);
      // Mark transaction as failed
      await getSupabaseAdmin()
        .from('paystack_transactions')
        .update({ status: 'failed_user_not_found' })
        .eq('reference', reference);
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const newBalance = (userData.tngn_balance || 0) + tNGNToCredit;

    const { error: updateError } = await getSupabaseAdmin()
      .from('users')
      .update({ tngn_balance: newBalance })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to credit balance:', updateError);
      await getSupabaseAdmin()
        .from('paystack_transactions')
        .update({ status: 'failed_balance_update' })
        .eq('reference', reference);
      return NextResponse.json({ error: 'Failed to credit balance' }, { status: 500 });
    }

    // 5. Mark transaction as completed
    await getSupabaseAdmin()
      .from('paystack_transactions')
      .update({ status: 'completed' })
      .eq('reference', reference);

    console.log(`Deposit complete: user=${userId}, NGN=${amountInNGN}, tNGN credited=${tNGNToCredit}, spread=${spreadAmount}`);

    return NextResponse.json({
      status: 'success',
      tNGNcredited: tNGNToCredit,
      spreadCaptured: spreadAmount,
    }, { status: 200 });

  } catch (error: unknown) {
    console.error('Paystack webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
