import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getMerchantBalance as paystackBalance } from '@/lib/paystack';
import { getMerchantBalance as squadBalance } from '@/lib/squad';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/admin/treasury
 *
 * Returns:
 *   - liveBalances: best-effort live "available to pay out" from each gateway's API
 *   - ledger: ledger-derived running totals (in/out/net) per gateway from treasury_movements
 *   - pendingWithdrawals: queue of withdrawals awaiting admin approval
 *
 * The live balance is what the gateway actually has access to; the ledger is
 * what our books say should be there. Drift between the two = something to
 * reconcile (failed payout, refund, fee anomaly).
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Live balances — these can fail (sandbox limits, API hiccups) so swallow errors per-gateway.
  const [pLive, sLive] = await Promise.allSettled([paystackBalance(), squadBalance()]);
  const livePaystack = pLive.status === 'fulfilled' ? pLive.value.availableKobo / 100 : null;
  const liveSquad = sLive.status === 'fulfilled' ? sLive.value.availableKobo / 100 : null;
  const liveErrors: Record<string, string> = {};
  if (pLive.status === 'rejected') liveErrors.paystack = String(pLive.reason?.message || pLive.reason);
  if (sLive.status === 'rejected') liveErrors.squad = String(sLive.reason?.message || sLive.reason);

  // Ledger aggregates per gateway — sum of treasury_movements.
  const { data: agg, error: aggErr } = await supabaseAdmin
    .from('treasury_movements')
    .select('gateway, direction, amount_ngn');

  if (aggErr) {
    return NextResponse.json({ error: aggErr.message }, { status: 500 });
  }

  const ledger: Record<'paystack' | 'squad' | 'unallocated', { in: number; out: number; net: number }> = {
    paystack: { in: 0, out: 0, net: 0 },
    squad: { in: 0, out: 0, net: 0 },
    unallocated: { in: 0, out: 0, net: 0 },
  };
  for (const row of agg || []) {
    const key = (row.gateway === 'paystack' || row.gateway === 'squad' ? row.gateway : 'unallocated') as
      'paystack' | 'squad' | 'unallocated';
    if (row.direction === 'in') ledger[key].in += Number(row.amount_ngn || 0);
    else if (row.direction === 'out') ledger[key].out += Number(row.amount_ngn || 0);
  }
  ledger.paystack.net = ledger.paystack.in - ledger.paystack.out;
  ledger.squad.net = ledger.squad.in - ledger.squad.out;
  ledger.unallocated.net = ledger.unallocated.in - ledger.unallocated.out;

  // Pending withdrawals queue — anything not yet completed/failed.
  const { data: pending } = await supabaseAdmin
    .from('withdrawals')
    .select('id, user_id, amount_tngn, naira_to_send, bank_code, account_number, account_name, status, gateway, created_at, requires_admin_approval')
    .in('status', ['pending_admin_approval', 'pending_paystack', 'queued_for_paystack'])
    .order('created_at', { ascending: true })
    .limit(100);

  // Hydrate user emails for the queue rows
  const userIds = Array.from(new Set((pending || []).map((w: any) => w.user_id).filter(Boolean)));
  const userMap = new Map<string, { email?: string; username?: string }>();
  if (userIds.length) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, email, username')
      .in('id', userIds);
    for (const u of users || []) userMap.set(u.id, { email: u.email, username: u.username });
  }

  const pendingHydrated = (pending || []).map((w: any) => ({
    ...w,
    user: userMap.get(w.user_id) || null,
  }));

  return NextResponse.json({
    liveBalances: {
      paystack: livePaystack,
      squad: liveSquad,
      errors: liveErrors,
    },
    ledger,
    pendingWithdrawals: pendingHydrated,
  });
}
