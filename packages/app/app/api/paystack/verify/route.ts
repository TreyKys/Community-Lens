import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyTransaction } from '@/lib/paystack';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CONVERSION_SPREAD = 0.015;
const DEPOSIT_PROMO = 0.01;

/**
 * POST /api/paystack/verify
 * Body: { reference: string }
 *
 * Called by the Paystack callback page right after redirect-back. We confirm
 * the charge with Paystack's /transaction/verify, then credit the user's
 * balance. Idempotent — if the transaction is already marked completed
 * (either by the webhook or a prior call), we return the cached result
 * without double-crediting.
 *
 * This is the primary credit path for card deposits. The webhook is a
 * redundant fallback for cases where the user closes the tab before redirect.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as { reference?: string }));
    const reference = String(body?.reference || '').trim();
    if (!reference) {
      return NextResponse.json({ error: 'Missing reference' }, { status: 400 });
    }

    // Look up our pending row (created by /api/paystack/initiate).
    const { data: row } = await supabaseAdmin
      .from('paystack_transactions')
      .select('reference, user_id, amount_ngn, status, tngn_credited')
      .eq('reference', reference)
      .single();

    if (row?.status === 'completed') {
      return NextResponse.json({
        status: 'completed',
        amount: row.amount_ngn,
        tngn_credited: row.tngn_credited,
      });
    }

    // Confirm with Paystack server-to-server.
    let psData;
    try {
      psData = await verifyTransaction(reference);
    } catch (err: any) {
      console.error('Paystack verify call failed:', err?.message || err);
      return NextResponse.json({ error: err?.message || 'Verification failed' }, { status: 502 });
    }

    if (psData.status !== 'success') {
      // Mark our row as failed so the callback page stops polling.
      if (row) {
        await supabaseAdmin
          .from('paystack_transactions')
          .update({ status: `failed_${psData.status || 'unknown'}` })
          .eq('reference', reference);
      }
      return NextResponse.json({
        status: psData.status || 'failed',
        message: psData.gateway_response || 'Payment did not complete.',
      });
    }

    // Recover user_id either from our pending row or from Paystack metadata.
    const userId: string | undefined = row?.user_id || psData.metadata?.userId;
    if (!userId) {
      console.error('Paystack verify: could not resolve user_id', { reference });
      return NextResponse.json({ error: 'Could not resolve user' }, { status: 404 });
    }

    const amountInNGN = Number(psData.amount) / 100;
    const spreadAmount = amountInNGN * CONVERSION_SPREAD;
    const tNGNToCredit = amountInNGN - spreadAmount;
    const betCredit = amountInNGN * DEPOSIT_PROMO;

    // Insert-if-missing so this works even if the popup-only path was used
    // historically and there's no pre-existing pending row.
    if (!row) {
      const { error: insertErr } = await supabaseAdmin.from('paystack_transactions').insert({
        reference,
        user_id: userId,
        amount_ngn: amountInNGN,
        tngn_credited: tNGNToCredit,
        spread_captured: spreadAmount,
        status: 'pending',
      });
      if (insertErr) {
        // 23505 = unique violation. Means the webhook beat us. Treat as success.
        if ((insertErr as any).code !== '23505') {
          console.error('Failed to insert paystack tx during verify:', insertErr);
          return NextResponse.json({ error: `Database error: ${insertErr.message}` }, { status: 500 });
        }
      }
    } else {
      // Mark as pending and fill in the spread breakdown.
      await supabaseAdmin
        .from('paystack_transactions')
        .update({
          amount_ngn: amountInNGN,
          tngn_credited: tNGNToCredit,
          spread_captured: spreadAmount,
          status: 'pending',
        })
        .eq('reference', reference);
    }

    // Atomic balance update.
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('tngn_balance, bonus_balance')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      await supabaseAdmin
        .from('paystack_transactions')
        .update({ status: 'failed_user_not_found' })
        .eq('reference', reference);
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Final guard against double-credit: re-check status.
    const { data: latest } = await supabaseAdmin
      .from('paystack_transactions')
      .select('status')
      .eq('reference', reference)
      .single();
    if (latest?.status === 'completed') {
      return NextResponse.json({
        status: 'completed',
        amount: amountInNGN,
        tngn_credited: tNGNToCredit,
      });
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
        .from('paystack_transactions')
        .update({ status: 'failed_balance_update' })
        .eq('reference', reference);
      return NextResponse.json({ error: 'Failed to credit balance' }, { status: 500 });
    }

    await supabaseAdmin
      .from('paystack_transactions')
      .update({ status: 'completed' })
      .eq('reference', reference);

    await supabaseAdmin.from('treasury_log').insert([
      { type: 'deposit_spread', amount_tngn: spreadAmount, user_id: userId, metadata: { source: 'paystack', reference } },
      { type: 'deposit_bet_credit', amount_tngn: -betCredit, user_id: userId, metadata: { source: 'paystack', reference } },
    ]);

    return NextResponse.json({
      status: 'completed',
      amount: amountInNGN,
      tngn_credited: tNGNToCredit,
      bonus_credit: betCredit,
    });
  } catch (e: any) {
    console.error('Paystack verify error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
