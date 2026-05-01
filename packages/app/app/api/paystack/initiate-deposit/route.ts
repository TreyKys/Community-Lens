import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';

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
 * POST /api/paystack/initiate-deposit
 * Body: { amount: number }   // naira
 *
 * Creates a Paystack-hosted checkout session for card / bank payments.
 * Inserts a `paystack_transactions` row with status='awaiting_payment' so the
 * webhook can credit by reference when the payment lands.
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

    const reference = `odds_ps_${randomUUID().replace(/-/g, '')}`;
    const amountKobo = Math.round(amount * 100);

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.headers.get('origin') ||
      `https://${request.headers.get('host')}`;
    const callbackUrl = `${origin}/wallet/paystack-callback`;

    // 1. Initialize Paystack Transaction
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw new Error('PAYSTACK_SECRET_KEY not configured');

    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountKobo,
        email,
        reference,
        callback_url: callbackUrl,
        metadata: {
          userId: authUser.id,
          channel: 'paystack_checkout'
        }
      }),
    });

    const data = await res.json();
    if (!data.status) {
      console.error('Paystack checkout init failed:', data.message);
      return NextResponse.json(
        { error: data.message || 'Could not start Paystack payment.' },
        { status: 502 }
      );
    }

    // 2. Record pending transaction in Supabase
    // Using stringified JSON or an empty object to avoid JSONB DB error if paystack responds oddly
    const { error: insertErr } = await supabaseAdmin.from('paystack_transactions').insert({
      reference,
      user_id: authUser.id,
      amount_ngn: amount,
      status: 'awaiting_payment',
    });

    if (insertErr) {
      console.error('Failed to record pending paystack transaction:', insertErr);
      return NextResponse.json({ error: 'Database error: ' + insertErr.message }, { status: 500 });
    }

    return NextResponse.json({
      checkoutUrl: data.data.authorization_url,
      reference,
    });
  } catch (e: any) {
    console.error('Paystack initiate-deposit error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
