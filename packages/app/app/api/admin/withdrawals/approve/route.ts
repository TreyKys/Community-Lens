import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { createTransferRecipient, initiateTransfer as paystackInitiate } from '@/lib/paystack';
import { initiateTransfer as squadInitiate } from '@/lib/squad';
import { randomUUID } from 'crypto';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/admin/withdrawals/approve
 * Body: { withdrawalId: string, gateway: 'paystack' | 'squad' }
 *
 * Approves a pending withdrawal and fires a real transfer through the chosen
 * gateway. Records the gateway choice + payout reference on the withdrawal row
 * and emits a treasury_movements row tagged with the gateway so the dashboard
 * stays accurate.
 *
 * Idempotency: if the row is already 'completed' or has a gateway_transfer_code,
 * we no-op. The user_bets/balance side has already been deducted in /api/withdraw.
 */
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({} as any));
    const withdrawalId = String(body?.withdrawalId || '').trim();
    const gateway = String(body?.gateway || '').toLowerCase();
    if (!withdrawalId) return NextResponse.json({ error: 'Missing withdrawalId' }, { status: 400 });
    if (gateway !== 'paystack' && gateway !== 'squad') {
      return NextResponse.json({ error: 'gateway must be paystack or squad' }, { status: 400 });
    }

    const { data: w, error: wErr } = await supabaseAdmin
      .from('withdrawals')
      .select('*')
      .eq('id', withdrawalId)
      .single();
    if (wErr || !w) return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 });
    if (w.gateway_transfer_code || w.status === 'completed') {
      return NextResponse.json({ status: 'already_processed', withdrawal: w });
    }

    const transactionRef = `odds_wd_${withdrawalId.slice(0, 8)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const amountKobo = Math.round(Number(w.naira_to_send) * 100);

    let transferCode: string;
    let transferStatus: string;
    let rawResponse: any;

    try {
      if (gateway === 'paystack') {
        // Paystack needs a recipient first.
        const recipientCode = await createTransferRecipient({
          name: w.account_name || w.bank_code,
          accountNumber: w.account_number,
          bankCode: w.bank_code,
        });
        const t = await paystackInitiate({
          recipientCode,
          amountNGN: Number(w.naira_to_send),
          reference: transactionRef,
          reason: `Odds.ng withdrawal ${withdrawalId.slice(0, 8)}`,
        });
        transferCode = t.transferCode;
        transferStatus = t.status;
        rawResponse = { recipientCode, ...t };
      } else {
        const t = await squadInitiate({
          amountKobo,
          bankCode: w.bank_code,
          accountNumber: w.account_number,
          accountName: w.account_name || 'Odds.ng User',
          transactionRef,
          remark: `Odds.ng withdrawal ${withdrawalId.slice(0, 8)}`,
        });
        transferCode = t.transactionRef;
        transferStatus = t.status;
        rawResponse = t;
      }
    } catch (err: any) {
      console.error(`[treasury approve] ${gateway} transfer failed`, err?.message || err);
      await supabaseAdmin
        .from('withdrawals')
        .update({
          status: 'failed_transfer',
          gateway,
          gateway_response: { error: String(err?.message || err) },
        })
        .eq('id', withdrawalId);
      return NextResponse.json({ error: err?.message || 'Transfer failed' }, { status: 502 });
    }

    // Mark approved + ledger row.
    await supabaseAdmin
      .from('withdrawals')
      .update({
        status: 'transfer_initiated',
        gateway,
        gateway_transfer_code: transferCode,
        gateway_response: rawResponse,
        approved_at: new Date().toISOString(),
      })
      .eq('id', withdrawalId);

    await supabaseAdmin.from('treasury_movements').insert({
      user_id: w.user_id,
      type: 'withdrawal',
      gateway,
      direction: 'out',
      amount_ngn: Number(w.naira_to_send),
      reference: withdrawalId,
      metadata: { transfer_code: transferCode, transfer_status: transferStatus },
    });

    // Notify the user.
    await supabaseAdmin.from('notifications').insert({
      user_id: w.user_id,
      type: 'withdrawal',
      message: `Your ₦${Number(w.naira_to_send).toLocaleString()} withdrawal has been approved. Funds en route via ${gateway === 'paystack' ? 'Paystack' : 'Squad'}.`,
      amount: Number(w.naira_to_send),
    });

    return NextResponse.json({
      status: 'success',
      gateway,
      transferCode,
      transferStatus,
    });
  } catch (e: any) {
    console.error('admin withdrawal approve error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
