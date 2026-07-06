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

    // Atomic refund + status flip + treasury reversal — see migration 20240621
    // (reject_withdrawal RPC). Replaces a non-atomic read-then-write flow
    // where a failure between the two queries could lose the user's refund.
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('reject_withdrawal', {
      p_withdrawal_id: withdrawalId,
      p_reason: reason,
    });

    if (rpcError) {
      const code = (rpcError as any)?.code;
      if (code === 'P0002') return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 });
      console.error('[reject] RPC failed', rpcError);
      return NextResponse.json({ error: rpcError.message || 'Reject failed' }, { status: 500 });
    }

    const r = rpcResult as any;
    if (r?.status === 'already_processed') {
      return NextResponse.json({ status: 'already_processed', previousStatus: r.previous_status });
    }

    // Send the user a heads-up. Notification failure can't roll back the
    // refund — fire-and-forget.
    if (r?.user_id) {
      await supabaseAdmin.from('notifications').insert({
        user_id: r.user_id,
        type: 'withdrawal',
        message: `Your ₦${Number(r.amount_tngn).toLocaleString()} withdrawal request was not approved. Funds returned to your wallet. Reason: ${reason}`,
        amount: Number(r.amount_tngn),
      });
    }

    return NextResponse.json({ status: 'rejected', refundedTNGN: Number(r?.refunded_tngn || 0) });
  } catch (e: any) {
    console.error('admin withdrawal reject error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
