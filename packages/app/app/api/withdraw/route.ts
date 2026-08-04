import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { findBankByCode } from '@/lib/banks';
import { sendOpsEmail, formatNaira } from '@/lib/ops-email';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Fee structure
const WITHDRAWAL_SPREAD = 0.01;    // 1% conversion spread
const WITHDRAWAL_FLAT_FEE = 50;    // ₦50 flat fee (covers gateway transfer cost)
const MIN_WITHDRAWAL_TNGN = 200;   // ₦200 floor
// Large withdrawal threshold — routes to manual admin approval
const LARGE_WITHDRAWAL_THRESHOLD = 500000; // ₦500,000 in tNGN

// NOTE (2026-07): the old VIP "skin-in-the-game" gate (block withdrawals
// until a VIP staked ₦10k lifetime) has been REMOVED. It was mis-scoped: it
// blocked the withdrawable wallet (tngn_balance), which only ever holds the
// VIP's own deposits + prediction winnings — while the earnings it meant to
// restrict (referral rake share) are credited to bonus_balance and are NEVER
// directly withdrawable in the first place. So the gate only ever punished
// money legitimately won from predictions. Earnings stay ring-fenced in
// bonus; the small bonus→cash leak via the winnings split is self-limiting
// (−EV against the house vig), so no separate gate is needed.

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const { amountTNGN, bankCode, accountNumber, accountName } = await request.json();

    if (!amountTNGN || !bankCode || !accountNumber) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const bank = findBankByCode(String(bankCode).trim());
    if (!bank) {
      return NextResponse.json({ error: 'Selected bank is not in our approved payout list' }, { status: 400 });
    }
    if (String(accountNumber).trim().length !== 10) {
      return NextResponse.json({ error: 'Account number must be a 10-digit NUBAN' }, { status: 400 });
    }

    if (amountTNGN < MIN_WITHDRAWAL_TNGN) {
      return NextResponse.json({ error: `Minimum withdrawal is ₦${MIN_WITHDRAWAL_TNGN}` }, { status: 400 });
    }

    // Fee math up front (so we can pass net values into the atomic RPC).
    const spreadAmount = amountTNGN * WITHDRAWAL_SPREAD;
    const nairaAfterSpread = amountTNGN - spreadAmount;
    const nairaToSend = nairaAfterSpread - WITHDRAWAL_FLAT_FEE;

    if (nairaToSend <= 0) {
      return NextResponse.json({ error: 'Amount too small after fees' }, { status: 400 });
    }

    // Atomic balance lock + deduct + withdrawal insert + fee-ledger row —
    // see migration 20240621 (request_withdrawal RPC). Replaces the previous
    // read-then-write balance flow which was vulnerable to concurrent
    // double-withdrawals (two requests both saw the pre-deduction balance).
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('request_withdrawal', {
      p_user_id: user.id,
      p_amount_tngn: amountTNGN,
      p_spread: spreadAmount,
      p_flat_fee: WITHDRAWAL_FLAT_FEE,
      p_naira_to_send: nairaToSend,
      p_bank_code: bankCode,
      p_account_number: accountNumber,
      p_account_name: accountName || null,
    });

    if (rpcError) {
      const code = (rpcError as any)?.code;
      if (code === 'P0001') {
        return NextResponse.json({ error: 'Insufficient withdrawable balance' }, { status: 400 });
      }
      if (code === 'P0002') {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      console.error('[withdraw] RPC failed', rpcError);
      return NextResponse.json({ error: 'Failed to create withdrawal request' }, { status: 500 });
    }

    const withdrawalId = (rpcResult as any)?.withdrawal_id;
    if (!withdrawalId) {
      return NextResponse.json({ error: 'Withdrawal RPC returned no id' }, { status: 500 });
    }

    const isLargeWithdrawal = amountTNGN >= LARGE_WITHDRAWAL_THRESHOLD;
    const withdrawal = { id: withdrawalId };
    console.log(`Withdrawal queued: user=${user.id}, tNGN=${amountTNGN}, NGN to send=${nairaToSend}, large=${isLargeWithdrawal}`);

    // Fire-and-forget — never block the user response on email delivery.
    sendOpsEmail({
      subject: `${isLargeWithdrawal ? '🔒 LARGE ' : ''}New withdrawal · ${formatNaira(nairaToSend)} · ${bank.name}`,
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;color:#111">
          <h2 style="margin:0 0 12px;font-size:18px">${isLargeWithdrawal ? '🔒 Large withdrawal — security audit required' : 'New withdrawal request'}</h2>
          <table style="border-collapse:collapse;width:100%;font-size:14px">
            <tr><td style="padding:6px 0;color:#666">User</td><td style="padding:6px 0;font-weight:600">${user.email || user.id.slice(0, 8)}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Amount to send</td><td style="padding:6px 0;font-weight:700;font-size:18px;color:#059669">${formatNaira(nairaToSend)}</td></tr>
            <tr><td style="padding:6px 0;color:#666">From wallet</td><td style="padding:6px 0">${formatNaira(amountTNGN)} tNGN</td></tr>
            <tr><td style="padding:6px 0;color:#666">Bank</td><td style="padding:6px 0;font-weight:600">${bank.name}</td></tr>
            <tr><td style="padding:6px 0;color:#666">NUBAN</td><td style="padding:6px 0;font-family:ui-monospace,monospace;font-weight:600">${accountNumber}</td></tr>
            ${accountName ? `<tr><td style="padding:6px 0;color:#666">Account name</td><td style="padding:6px 0">${accountName}</td></tr>` : ''}
            <tr><td style="padding:6px 0;color:#666">Withdrawal ID</td><td style="padding:6px 0;font-family:ui-monospace,monospace;font-size:12px;color:#888">${withdrawal.id}</td></tr>
          </table>
          <p style="margin:20px 0 8px;font-size:13px;color:#555">
            ${isLargeWithdrawal
              ? '⚠️ Large withdrawal — review carefully before sending. Confirm user identity if anything looks off.'
              : 'Open the admin dashboard to mark this as paid once you\'ve sent the transfer.'}
          </p>
          <a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://opinions.ng'}/admin?tab=withdrawals"
             style="display:inline-block;margin-top:8px;padding:10px 16px;background:#059669;color:white;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">
            Open Admin Dashboard
          </a>
        </div>
      `,
    }).catch(() => {}); // truly fire-and-forget

    return NextResponse.json({
      status: 'under_review',
      withdrawalId: withdrawal.id,
      amountTNGN,
      nairaToReceive: nairaToSend,
      feesDeducted: spreadAmount + WITHDRAWAL_FLAT_FEE,
      message: isLargeWithdrawal
        ? 'Your withdrawal is being processed. Due to its size, it requires a security audit. This can take up to 24 hours.'
        : 'Withdrawal received. Withdrawals are reviewed and released to your bank within 24 hours.',
    }, { status: 200 });

  } catch (error: any) {
    console.error('Withdrawal error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
