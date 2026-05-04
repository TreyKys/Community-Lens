import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { initializeTransaction } from '@/lib/paystack';

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
 * POST /api/paystack/initiate
 * Body: { amount: number }   // naira
 *
 * Server-side initialization. Generates a unique reference, inserts a pending
 * row in paystack_transactions, calls Paystack's /transaction/initialize, and
 * returns an authorization_url for the client to redirect to.
 *
 * After payment Paystack redirects to /wallet/paystack-callback?reference=...,
 * which calls /api/paystack/verify to confirm the charge and credit balance.
 * The webhook at /api/webhooks/paystack remains as an idempotent fallback.
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
      .select('email')
      .eq('id', authUser.id)
      .single();
    const email = profile?.email || authUser.email || `${authUser.id}@odds.ng`;

    const reference = `odds_ps_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const amountKobo = Math.round(amount * 100);

    const origin =
      process.env.NEXT_PUBLIC_APP_URL ||
      request.headers.get('origin') ||
      `https://${request.headers.get('host')}`;
    const callbackUrl = `${origin}/wallet/paystack-callback`;

    let result;
    try {
      result = await initializeTransaction({
        email,
        amountKobo,
        reference,
        callbackUrl,
        metadata: { userId: authUser.id, channel: 'card' },
      });
    } catch (err: any) {
      console.error('Paystack initialize failed:', err?.message || err);
      return NextResponse.json(
        { error: err?.message || 'Could not start payment.' },
        { status: 502 }
      );
    }

    const { error: insertErr } = await supabaseAdmin.from('paystack_transactions').insert({
      reference,
      user_id: authUser.id,
      amount_ngn: amount,
      status: 'awaiting_payment',
    });
    if (insertErr) {
      console.error('Failed to record pending paystack transaction:', insertErr);
      return NextResponse.json(
        { error: `Database error: ${insertErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      authorizationUrl: result.authorizationUrl,
      reference,
    });
  } catch (e: any) {
    console.error('Paystack initiate error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
