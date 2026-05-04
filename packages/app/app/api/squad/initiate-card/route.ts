import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { initiateCheckout } from '@/lib/squad';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function getAuthUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * POST /api/squad/initiate-card
 * Body: { amount: number }   // naira
 *
 * Creates a Squad-hosted checkout session for card / USSD / bank.
 * Inserts a `squad_transactions` row with status='awaiting_payment' so the
 * webhook can credit by transaction_ref when the payment lands.
 *
 * Returns { checkoutUrl, transactionRef }. Client should redirect the user
 * to checkoutUrl (or open it in a popup).
 */
export async function POST(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({} as { amount?: number }));
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount < 100) {
      return NextResponse.json({ error: 'Enter an amount of at least ₦100.' }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: 'Single deposit capped at ₦1,000,000.' }, { status: 400 });
    }

    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('email, username, first_name, last_name')
      .eq('id', authUser.id)
      .single();

    const email = profile?.email || authUser.email || `${authUser.id}@odds.ng`;
    const fallbackName = profile?.username || email.split('@')[0] || 'Odds';
    const firstName = profile?.first_name || fallbackName.split(/\s+/)[0] || 'Odds';
    const lastName = profile?.last_name || fallbackName.split(/\s+/).slice(1).join(' ') || 'Punter';
    const customerName = `${firstName} ${lastName}`.trim();

    const transactionRef = `odds_card_${randomUUID().replace(/-/g, '')}`;
    const amountKobo = Math.round(amount * 100);

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.headers.get('origin') ||
      `https://${request.headers.get('host')}`;
    const callbackUrl = `${origin}/wallet/squad-callback?ref=${transactionRef}`;

    let session;
    try {
      session = await initiateCheckout({
        amountKobo,
        email,
        transactionRef,
        callbackUrl,
        customerName,
        metadata: { user_id: authUser.id, channel: 'card' },
      });
    } catch (err: any) {
      console.error('Squad checkout init failed:', err?.message || err);
      return NextResponse.json(
        { error: err?.message || 'Could not start payment.' },
        { status: 502 }
      );
    }

    // expected_amount lives in raw_payload so this works whether or not
    // migration 20240510 (which adds the dedicated column) has been applied.
    const { error: insertErr } = await supabaseAdmin.from('squad_transactions').insert({
      transaction_ref: transactionRef,
      user_id: authUser.id,
      amount_ngn: amount,
      status: 'awaiting_payment',
      raw_payload: { checkout: session, channel: 'card', expected_amount: amount },
    });
    if (insertErr) {
      console.error('Failed to record pending squad card transaction:', insertErr);
      return NextResponse.json(
        { error: `Database error: ${insertErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      checkoutUrl: session.checkout_url,
      transactionRef,
    });
  } catch (e: any) {
    console.error('Squad initiate-card error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
