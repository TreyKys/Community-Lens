import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/admin/withdrawals/reject
 * Body: { withdrawalId: string, reason?: string }
 *
 * Rejects a pending withdrawal, refunds the user's tNGN balance, and clears
 * the entry from the queue. The fee row in treasury_movements is reversed too.
 */
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({} as any));
    const withdrawalId = String(body?.withdrawalId || '').trim();
    const reason = String(body?.reason || 'Admin rejection');
    if (!withdrawalId) return NextResponse.json({ error: 'Missing withdrawalId' }, { status: 400 });

    const { data: w, error: wErr } = await supabaseAdmin
      .from('withdrawals')
      .select('*')
      .eq('id', withdrawalId)
      .single();
    if (wErr || !w) return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 });
    if (w.status === 'completed' || w.status === 'transfer_initiated') {
      return NextResponse.json({ error: 'Withdrawal already processed' }, { status: 409 });
    }
    if (w.status === 'rejected' || w.status === 'refunded') {
      return NextResponse.json({ status: 'already_rejected' });
    }

    // Refund the user's tNGN balance.
    const { data: u } = await supabaseAdmin
      .from('users')
      .select('tngn_balance')
      .eq('id', w.user_id)
      .single();

    await supabaseAdmin
      .from('users')
      .update({ tngn_balance: (u?.tngn_balance || 0) + Number(w.amount_tngn) })
      .eq('id', w.user_id);

    await supabaseAdmin
      .from('withdrawals')
      .update({
        status: 'rejected',
        gateway_response: { reason },
        approved_at: new Date().toISOString(),
      })
      .eq('id', withdrawalId);

    // Reverse the fee-capture treasury movement.
    await supabaseAdmin.from('treasury_movements').insert({
      user_id: w.user_id,
      type: 'refund',
      gateway: null,
      direction: 'out',
      amount_ngn: Number(w.spread_amount || 0) + Number(w.flat_fee || 0),
      reference: withdrawalId,
      metadata: { source: 'withdrawal_reject', reason },
    });

    await supabaseAdmin.from('notifications').insert({
      user_id: w.user_id,
      type: 'withdrawal',
      message: `Your ₦${Number(w.amount_tngn).toLocaleString()} withdrawal request was not approved. Funds returned to your wallet. Reason: ${reason}`,
      amount: Number(w.amount_tngn),
    });

    return NextResponse.json({ status: 'rejected', refundedTNGN: Number(w.amount_tngn) });
  } catch (e: any) {
    console.error('admin withdrawal reject error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
