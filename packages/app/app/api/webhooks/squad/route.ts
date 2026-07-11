import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 1% conversion spread; deposit promo retired in favour of the weekly loss rebate.
const CONVERSION_SPREAD = 0.01;

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-squad-encrypted-body');
    const secret = process.env.SQUAD_SECRET_KEY;

    if (!secret || !signature) {
      return NextResponse.json({ error: 'Missing secret or signature' }, { status: 400 });
    }

    // Squad signs the raw body with HMAC-SHA512 keyed by the secret key (uppercase hex).
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex').toUpperCase();
    if (hash !== signature.toUpperCase()) {
      console.error('Squad signature verification failed.');
      return NextResponse.json({ error: 'Unauthorized payload' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    const event = (payload.event || payload.Event || '').toLowerCase();
    // Accept VA credits and card/USSD payment events. Ignore everything else.
    const ACCEPTED_EVENTS = [
      'transaction_notification',   // VA bank transfer
      'successful_transaction',      // VA alternate name
      'charge_successful',           // card / USSD checkout
      'transaction_successful',      // card alternate name
      'payment_notification',        // some sandbox payloads
    ];
    if (event && !ACCEPTED_EVENTS.includes(event)) {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const data = payload.data || payload;
    const transactionRef: string | undefined =
      data.transaction_ref || data.transaction_reference || data.reference;
    const customerIdentifier: string | undefined = data.customer_identifier;
    const amountField = data.transaction_amount ?? data.amount;
    const accountNumber: string | undefined = data.virtual_account_number || data.account_number;

    if (!transactionRef || !amountField) {
      return NextResponse.json({ error: 'Missing transaction fields' }, { status: 400 });
    }

    // Lookup #1: pre-existing pending row created by /api/squad/provision-account.
    const { data: pending } = await supabaseAdmin
      .from('squad_transactions')
      .select('id, user_id, status')
      .eq('transaction_ref', transactionRef)
      .single();

    if (pending && pending.status === 'completed') {
      return NextResponse.json({ status: 'already processed' }, { status: 200 });
    }

    // Lookup #2: fall back to a static virtual account (legacy path) or the
    // customer_identifier Squad echoes back, in that order.
    let userId: string | null = pending?.user_id || null;
    if (!userId && accountNumber) {
      const { data: vAccount } = await supabaseAdmin
        .from('squad_virtual_accounts')
        .select('user_id')
        .eq('account_number', accountNumber)
        .single();
      userId = vAccount?.user_id || null;
    }
    if (!userId && customerIdentifier) {
      const { data: byId } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('id', customerIdentifier)
        .single();
      userId = byId?.id || null;
    }

    if (!userId) {
      console.error('Squad webhook: could not map credit to a user', { transactionRef, accountNumber, customerIdentifier });
      return NextResponse.json({ error: 'Account not provisioned' }, { status: 404 });
    }

    const amountInNGN = Number(amountField);
    const spreadAmount = amountInNGN * CONVERSION_SPREAD;
    const tNGNToCredit = amountInNGN - spreadAmount;

    // Ensure a squad_transactions row exists for this ref so
    // settle_squad_deposit has a row to lock. For the live hosted-checkout
    // path the row already exists (created at initiate); for the legacy VA
    // path it may not, so insert one in a not-yet-credited state. We do
    // NOT reset an existing row's status here — the old unguarded
    // reset-to-'pending' could clobber an in-flight verify credit and
    // cause a double credit; settle_squad_deposit is the single source of
    // truth for state transitions now.
    if (!pending) {
      const { error: insertError } = await supabaseAdmin
        .from('squad_transactions')
        .insert({
          transaction_ref: transactionRef,
          user_id: userId,
          amount_ngn: amountInNGN,
          tngn_credited: tNGNToCredit,
          spread_captured: spreadAmount,
          status: 'awaiting_payment',
          raw_payload: payload,
        });
      if (insertError) {
        // Race: another webhook delivery beat us to this ref. The row now
        // exists; fall through to settle it idempotently.
        if ((insertError as any)?.code !== '23505') {
          console.error('Failed to insert squad transaction:', insertError);
          return NextResponse.json({ error: 'Database error' }, { status: 500 });
        }
      }
    } else {
      // Keep the raw payload for audit, but never touch status.
      await supabaseAdmin
        .from('squad_transactions')
        .update({ raw_payload: payload })
        .eq('id', pending.id);
    }

    // Atomic credit — one transaction, row-locked, idempotent, recovery-
    // safe. Handles the verify-vs-webhook race and any stuck state without
    // double-crediting. See migration 20260712000000.
    const { data: settleRows, error: settleErr } = await supabaseAdmin.rpc('settle_squad_deposit', {
      p_transaction_ref: transactionRef,
      p_amount_ngn: amountInNGN,
    });
    if (settleErr) {
      // Return non-2xx so Squad RETRIES the webhook — the row is provably
      // uncredited (the RPC rolled back). This is the retry backstop.
      console.error('settle_squad_deposit (webhook) failed:', settleErr);
      const code = (settleErr as any)?.code === 'P0002' ? 404 : 500;
      return NextResponse.json({ error: 'Failed to credit balance' }, { status: code });
    }
    const settle = Array.isArray(settleRows) ? settleRows[0] : settleRows;
    const outcome = settle?.outcome as string | undefined;

    if (outcome === 'needs_review') {
      // Legacy ambiguous row — do not auto-credit; a 200 stops Squad
      // retrying into the same ambiguity. Admin review handles it.
      console.error('settle_squad_deposit (webhook): needs manual review', { transactionRef });
      return NextResponse.json({ status: 'needs_review' }, { status: 200 });
    }
    if (outcome !== 'credited') {
      // 'already_credited' or 'not_found' — nothing more to do. Ack so
      // Squad stops retrying.
      return NextResponse.json({ status: 'already processed' }, { status: 200 });
    }

    // outcome === 'credited' — fresh credit. Non-critical extras follow,
    // gated so a webhook redelivery after crediting never duplicates them.
    await supabaseAdmin.from('treasury_log').insert([
      { type: 'deposit_spread', amount_tngn: spreadAmount, user_id: userId, metadata: { source: 'squad', transaction_ref: transactionRef } },
    ]);

    // Tell the user the deposit landed. Previously only the welcome
    // bonus (first deposit only) notified, so a returning user who
    // topped up heard nothing and had to refresh to see the balance.
    try {
      await supabaseAdmin.from('notifications').insert({
        user_id: userId,
        type: 'deposit_credited',
        message: `Deposit received — ₦${Math.round(tNGNToCredit).toLocaleString()} added to your wallet. Ready to predict.`,
        amount: tNGNToCredit,
      });
    } catch { /* notification non-critical */ }

    // Welcome Match: idempotent per-user, only fires on the first qualifying
    // deposit and only inside the offer window. We pass the GROSS deposit
    // (not the post-spread number) so the RPC's min-deposit threshold lines
    // up with what the user sees in the WalletModal — "Minimum deposit is
    // ₦500" → depositing exactly ₦500 must qualify, even though our 1%
    // spread leaves only ₦495 in their wallet. Failure here must not break
    // the deposit flow. A notification fires alongside the treasury log so
    // the user actually sees that the bonus landed.
    let welcomeCredit = 0;
    try {
      const { data: matchAmt } = await supabaseAdmin.rpc('claim_welcome_match', {
        p_user_id: userId,
        p_deposit_amount: amountInNGN,
      });
      welcomeCredit = Number(matchAmt || 0);
      if (welcomeCredit > 0) {
        await supabaseAdmin.from('treasury_log').insert([
          { type: 'welcome_match', amount_tngn: welcomeCredit, user_id: userId, metadata: { source: 'squad', transaction_ref: transactionRef } },
        ]);
        try {
          await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            type: 'welcome_match',
            message: `🎉 Welcome bonus! ₦${welcomeCredit.toLocaleString()} matched on your first deposit. Spend it on your next prediction.`,
            amount: welcomeCredit,
          });
        } catch { /* notification non-critical */ }
      }
    } catch (e: any) {
      console.error('Welcome match grant failed (deposit still credited):', e?.message || e);
    }

    return NextResponse.json({
      status: 'success',
      tNGNcredited: tNGNToCredit,
      spreadCaptured: spreadAmount,
      welcomeMatchCredit: welcomeCredit,
    }, { status: 200 });
  } catch (e: any) {
    console.error('Squad webhook error:', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
