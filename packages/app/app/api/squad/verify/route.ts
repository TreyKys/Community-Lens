import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyTransaction } from '@/lib/squad';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CONVERSION_SPREAD = 0.015;
const DEPOSIT_PROMO = 0.01;

/**
 * POST /api/squad/verify
 * Body: { reference: string }
 *
 * Called by the Squad callback page immediately after redirect-back.
 * Confirms the charge with Squad's /transaction/verify, then credits the
 * user's balance. Idempotent — a completed row is returned as-is without
 * double-crediting. The webhook remains a redundant fallback.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as { reference?: string }));
    const reference = String(body?.reference || '').trim();
    if (!reference) {
      return NextResponse.json({ error: 'Missing reference' }, { status: 400 });
    }

    // Look up the pending row we created in /api/squad/initiate-card.
    const { data: row } = await supabaseAdmin
      .from('squad_transactions')
      .select('transaction_ref, user_id, amount_ngn, status, tngn_credited')
      .eq('transaction_ref', reference)
      .single();

    if (row?.status === 'completed') {
      return NextResponse.json({
        status: 'completed',
        amount: row.amount_ngn,
        tngn_credited: row.tngn_credited,
      });
    }

    // Confirm with Squad server-to-server.
    let squadData: any;
    try {
      squadData = await verifyTransaction(reference);
    } catch (err: any) {
      console.error('Squad verify call failed:', err?.message || err);
      return NextResponse.json({ error: err?.message || 'Verification failed' }, { status: 502 });
    }

    // Squad returns transaction_status or gateway_response depending on endpoint version.
    const txStatus: string =
      squadData?.transaction_status ||
      squadData?.gateway_response ||
      squadData?.status ||
      '';

    if (txStatus.toLowerCase() !== 'successful' && txStatus.toLowerCase() !== 'success') {
      if (row) {
        await supabaseAdmin
          .from('squad_transactions')
          .update({ status: `failed_${txStatus || 'unknown'}` })
          .eq('transaction_ref', reference);
      }
      return NextResponse.json({
        status: txStatus || 'failed',
        message: 'Payment did not complete.',
      });
    }

    const userId: string | undefined = row?.user_id || squadData?.meta?.user_id;
    if (!userId) {
      console.error('Squad verify: could not resolve user_id', { reference });
      return NextResponse.json({ error: 'Could not resolve user' }, { status: 404 });
    }

    // Amount from Squad's verify may be in kobo or naira depending on the endpoint.
    // Our row already has the correct naira figure; use that as the source of truth.
    const amountInNGN = row?.amount_ngn ?? Number(squadData?.amount ?? 0) / 100;
    const spreadAmount = amountInNGN * CONVERSION_SPREAD;
    const tNGNToCredit = amountInNGN - spreadAmount;
    const betCredit = amountInNGN * DEPOSIT_PROMO;

    // Guard against double-credit from a concurrent webhook.
    const { data: latest } = await supabaseAdmin
      .from('squad_transactions')
      .select('status')
      .eq('transaction_ref', reference)
      .single();
    if (latest?.status === 'completed') {
      return NextResponse.json({ status: 'completed', amount: amountInNGN, tngn_credited: tNGNToCredit });
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
        .eq('transaction_ref', reference);
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('users')
      .update({
        tngn_balance: (userData.tngn_balance || 0) + tNGNToCredit,
        bonus_balance: (userData.bonus_balance || 0) + betCredit,
      })
      .eq('id', userId);

    if (updateErr) {
      await supabaseAdmin
        .from('squad_transactions')
        .update({ status: 'failed_balance_update' })
        .eq('transaction_ref', reference);
      return NextResponse.json({ error: 'Failed to credit balance' }, { status: 500 });
    }

    await supabaseAdmin
      .from('squad_transactions')
      .update({ status: 'completed', tngn_credited: tNGNToCredit, spread_captured: spreadAmount })
      .eq('transaction_ref', reference);

    await supabaseAdmin.from('treasury_log').insert([
      { type: 'deposit_spread', amount_tngn: spreadAmount, user_id: userId, metadata: { source: 'squad_card', transaction_ref: reference } },
      { type: 'deposit_bet_credit', amount_tngn: -betCredit, user_id: userId, metadata: { source: 'squad_card', transaction_ref: reference } },
    ]);

    return NextResponse.json({ status: 'completed', amount: amountInNGN, tngn_credited: tNGNToCredit });
  } catch (e: any) {
    console.error('Squad verify error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
