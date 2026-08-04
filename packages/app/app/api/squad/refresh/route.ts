import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyTransaction } from '@/lib/squad';
import { settleSquadDeposit } from '@/lib/settleSquadDeposit';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/squad/refresh
// Body: { reference?: string }   // a specific deposit; omit to refresh the
//                                   caller's most recent non-completed deposit
//
// On-demand re-check of a deposit's status, callable by:
//   * the DEPOSIT'S OWNER  (Bearer access token), or
//   * an ADMIN             (admin cookie / bearer secret, via isAdminRequest)
//
// Re-verifies the charge with Squad server-to-server and, if Squad now
// confirms it succeeded, credits it through the same atomic settle path the
// live flows use. This is the manual companion to the reconcile cron: it
// lets a user or an admin un-stick a paid-but-uncredited deposit immediately
// instead of waiting for the next sweep. Idempotent — a completed deposit
// just reports 'completed' and credits nothing twice.

const TERMINAL_FAILURES = ['failed', 'declined', 'decline', 'reversed', 'reversal', 'cancelled', 'canceled', 'expired', 'abandoned', 'void', 'voided', 'reverted', 'rejected'];

function classify(squadData: any): 'success' | 'terminal' | 'transient' {
  const s = String(
    squadData?.transaction_status || squadData?.gateway_response || squadData?.status || '',
  ).toLowerCase();
  if (s === 'successful' || s === 'success') return 'success';
  if (TERMINAL_FAILURES.some(t => s.includes(t))) return 'terminal';
  return 'transient';
}

async function resolveBearerUser(request: Request): Promise<string | null> {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as { reference?: string }));
  const reference = String(body?.reference || '').trim();

  const admin = isAdminRequest(request);
  const bearerUserId = admin ? null : await resolveBearerUser(request);
  if (!admin && !bearerUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Resolve the target row. A non-admin may only ever touch their own
  // deposits — either the ref they passed (ownership re-checked) or their
  // latest non-completed one.
  let row: { transaction_ref: string; user_id: string; amount_ngn: number; status: string; tngn_credited: number | null } | null = null;

  if (reference) {
    const q = supabaseAdmin
      .from('squad_transactions')
      .select('transaction_ref, user_id, amount_ngn, status, tngn_credited')
      .eq('transaction_ref', reference);
    if (!admin) q.eq('user_id', bearerUserId!); // ownership guard
    const { data } = await q.maybeSingle();
    row = data as any;
  } else if (!admin) {
    // No ref — refresh the caller's most recent still-open deposit.
    const { data } = await supabaseAdmin
      .from('squad_transactions')
      .select('transaction_ref, user_id, amount_ngn, status, tngn_credited')
      .eq('user_id', bearerUserId!)
      .neq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    row = data as any;
  } else {
    return NextResponse.json({ error: 'Provide a reference' }, { status: 400 });
  }

  if (!row) {
    return NextResponse.json({ status: 'not_found', message: 'No matching deposit found.' }, { status: 404 });
  }

  // Already done — nothing to do.
  if (row.status === 'completed') {
    return NextResponse.json({
      status: 'completed',
      reference: row.transaction_ref,
      amount: row.amount_ngn,
      tngn_credited: row.tngn_credited,
      message: 'This deposit is already credited.',
    });
  }

  // Re-verify with Squad.
  let squadData: any;
  try {
    squadData = await verifyTransaction(row.transaction_ref);
  } catch (err: any) {
    return NextResponse.json(
      { status: 'processing', reference: row.transaction_ref, message: 'Could not reach the payment provider — try again in a moment.' },
      { status: 502 },
    );
  }

  const kind = classify(squadData);

  if (kind === 'terminal') {
    // Genuinely failed — stamp it (without clobbering a concurrent credit).
    await supabaseAdmin
      .from('squad_transactions')
      .update({ status: 'failed_verified' })
      .eq('transaction_ref', row.transaction_ref)
      .not('status', 'in', '("completed","crediting")');
    return NextResponse.json({ status: 'failed', reference: row.transaction_ref, message: 'Payment did not complete. No charge stands.' });
  }

  if (kind === 'transient') {
    return NextResponse.json({ status: 'processing', reference: row.transaction_ref, message: 'Payment is still being confirmed. Check back shortly.' });
  }

  // kind === 'success' — credit through the atomic settle path.
  const settle = await settleSquadDeposit(supabaseAdmin, row.transaction_ref, row.amount_ngn);
  if (settle.error) {
    return NextResponse.json(
      { status: 'processing', reference: row.transaction_ref, message: 'Crediting your deposit — refresh again in a moment.' },
      { status: 502 },
    );
  }
  if (settle.outcome === 'needs_review') {
    return NextResponse.json({ status: 'needs_review', reference: row.transaction_ref, message: 'This deposit needs manual review by support.' });
  }
  if (settle.outcome === 'pending') {
    return NextResponse.json({ status: 'processing', reference: row.transaction_ref, message: 'Deposit is being confirmed — refresh again shortly.' });
  }

  // 'credited' (fresh) or 'already_credited' — both mean the money is in.
  if (settle.outcome === 'credited') {
    // Mirror the live paths' non-critical extras on a FRESH credit only, so a
    // manual refresh that wins the race still logs the spread + notifies.
    await supabaseAdmin.from('treasury_log').insert([
      { type: 'deposit_spread', amount_tngn: settle.spread, user_id: row.user_id, metadata: { source: 'squad_refresh', transaction_ref: row.transaction_ref } },
    ]).then(() => undefined, () => undefined);
    await supabaseAdmin.from('notifications').insert({
      user_id: row.user_id,
      type: 'deposit_credited',
      message: `Deposit received — ₦${Math.round(settle.tngnCredited).toLocaleString()} added to your wallet. Ready to predict.`,
      amount: settle.tngnCredited,
    }).then(() => undefined, () => undefined);
  }

  return NextResponse.json({
    status: 'completed',
    reference: row.transaction_ref,
    amount: row.amount_ngn,
    tngn_credited: settle.tngnCredited,
    fresh: settle.outcome === 'credited',
    message: settle.outcome === 'credited' ? 'Deposit credited to your wallet.' : 'This deposit is already credited.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
