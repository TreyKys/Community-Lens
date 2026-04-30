import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createDynamicVirtualAccount } from '@/lib/squad';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DEFAULT_TTL_SECONDS = 1800; // 30 min — Squad default

async function getAuthUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * POST /api/squad/provision-account
 * Body: { amount: number }   // naira
 *
 * Mints a one-shot Dynamic Virtual Account for this deposit attempt and
 * inserts a `squad_transactions` row with `status='awaiting_payment'`. The
 * webhook reconciles by `transaction_ref` when the user actually pays.
 *
 * No BVN / KYC required — that's the whole point of using the dynamic
 * endpoint instead of the static one.
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

    const transactionRef = `odds_${randomUUID().replace(/-/g, '')}`;
    const amountKobo = Math.round(amount * 100);
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000).toISOString();

    let account;
    try {
      account = await createDynamicVirtualAccount({
        customerIdentifier: authUser.id,
        firstName,
        lastName,
        email,
        amountKobo,
        durationSeconds: DEFAULT_TTL_SECONDS,
        transactionRef,
      });
    } catch (err: any) {
      console.error('Squad dynamic VA creation failed:', err?.message || err);
      return NextResponse.json(
        { error: err?.message || 'Could not create deposit account.' },
        { status: 502 }
      );
    }

    const { error: insertErr } = await supabaseAdmin.from('squad_transactions').insert({
      transaction_ref: transactionRef,
      user_id: authUser.id,
      amount_ngn: amount,
      expected_amount: amount,
      expires_at: expiresAt,
      status: 'awaiting_payment',
      raw_payload: { dynamic_va: account },
    });

    if (insertErr) {
      console.error('Failed to record pending squad transaction:', insertErr);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    return NextResponse.json({
      accountNumber: account.virtual_account_number,
      accountName: account.account_name,
      bankName: account.bank,
      bankCode: account.bank_code,
      amount,
      expiresAt,
      transactionRef,
    });
  } catch (e: any) {
    console.error('Squad initiate-transfer error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
