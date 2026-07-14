import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyTransaction } from '@/lib/squad';
import { settleSquadDeposit } from '@/lib/settleSquadDeposit';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CONVERSION_SPREAD = 0.01;
// Deposit promo retired — replaced by weekly loss rebate.

/**
 * POST /api/squad/verify
 * Body: { reference: string }
 *
 * Called by the Squad callback page immediately after redirect-back.
 * Confirms the charge with Squad's /transaction/verify, then credits the
 * user's balance. Idempotent — a completed row is returned as-is without
 * double-crediting. The webhook remains a redundant fallback.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as { reference?: string }));
    const reference = String(body?.reference || '').trim();
    if (!reference) {
      return NextResponse.json({ error: 'Missing reference' }, { status: 400 });
    }

    // Look up the pending row we created in /api/squad/initiate-card.
    const { data: row } = await supabaseAdmin
      .from('squad_transactions')
      .select('transaction_ref, user_id, amount_ngn, status, tngn_credited')
      .eq('transaction_ref', reference)
      .single();

    if (row?.status === 'completed') {
      return NextResponse.json({
        status: 'completed',
        amount: row.amount_ngn,
        tngn_credited: row.tngn_credited,
      });
    }

    // Confirm with Squad server-to-server.
    let squadData: any;
    try {
      squadData = await verifyTransaction(reference);
    } catch (err: any) {
      console.error('Squad verify call failed:', err?.message || err);
      return NextResponse.json({ error: err?.message || 'Verification failed' }, { status: 502 });
    }

    // Squad returns transaction_status or gateway_response depending on endpoint version.
    const txStatus: string =
      squadData?.transaction_status ||
      squadData?.gateway_response ||
      squadData?.status ||
      '';

    if (txStatus.toLowerCase() !== 'successful' && txStatus.toLowerCase() !== 'success') {
      if (row) {
        await supabaseAdmin
          .from('squad_transactions')
          .update({ status: `failed_${txStatus || 'unknown'}` })
          .eq('transaction_ref', reference);
      }
      return NextResponse.json({
        status: txStatus || 'failed',
        message: 'Payment did not complete.',
      });
    }

    const userId: string | undefined = row?.user_id || squadData?.meta?.user_id;
    if (!userId) {
      console.error('Squad verify: could not resolve user_id', { reference });
      return NextResponse.json({ error: 'Could not resolve user' }, { status: 404 });
    }

    // Amount from Squad's verify may be in kobo or naira depending on the endpoint.
    // Our row already has the correct naira figure; use that as the source of truth.
    const amountInNGN = row?.amount_ngn ?? Number(squadData?.amount ?? 0) / 100;
    const spreadAmount = amountInNGN * CONVERSION_SPREAD;
    const tNGNToCredit = amountInNGN - spreadAmount;

    // Atomic credit via the settle_squad_deposit RPC (one transaction,
    // row-locked — can't leave a half-done state or double-credit under
    // the verify-vs-webhook race). The helper falls back to an idempotent
    // inline credit if that migration isn't applied yet, so a deposit is
    // never lost just because the DB migration is pending.
    const settle = await settleSquadDeposit(supabaseAdmin, reference, amountInNGN);
    const outcome = settle.outcome;

    if (settle.error) {
      // A transient/real error left the row provably uncredited and
      // retriable. Return non-2xx so the callback poller retries and the
      // reconciliation cron can also pick it up — we do NOT falsely tell
      // the user "completed" the way the old code did.
      console.error('settleSquadDeposit failed:', settle.error, { reference });
      const code = settle.error === 'P0002' ? 404 : 502;
      return NextResponse.json({ status: 'processing', error: 'Crediting your deposit — refresh in a moment.' }, { status: code });
    }
    if (outcome === 'not_found') {
      return NextResponse.json({ error: 'Deposit not found' }, { status: 404 });
    }
    if (outcome === 'needs_review' || outcome === 'pending') {
      // Ambiguous/in-flight — flagged for manual review or a retry, not
      // auto-credited. Don't claim success.
      console.error('settleSquadDeposit: not settled', { reference, outcome });
      return NextResponse.json({ status: 'processing', message: 'Deposit is being confirmed. If it doesn’t reflect shortly, contact support.' });
    }
    if (outcome === 'already_credited') {
      return NextResponse.json({ status: 'completed', amount: amountInNGN, tngn_credited: settle.tngnCredited });
    }
    // outcome === 'credited' — a fresh credit just happened. Only now do
    // the non-critical extras, so a re-verify (already_credited) never
    // duplicates the legacy log / notification / bonus.

    await supabaseAdmin.from('treasury_log').insert([
      { type: 'deposit_spread', amount_tngn: spreadAmount, user_id: userId, metadata: { source: 'squad_card', transaction_ref: reference } },
    ]);

    // Deposit-landed notification. Only fires on a fresh credit, so the
    // user never gets two "deposit received" pings for the same top-up.
    try {
      await supabaseAdmin.from('notifications').insert({
        user_id: userId,
        type: 'deposit_credited',
        message: `Deposit received — ₦${Math.round(tNGNToCredit).toLocaleString()} added to your wallet. Ready to predict.`,
        amount: tNGNToCredit,
      });
    } catch { /* notification non-critical */ }

    // Welcome Match grant. Webhook does the same thing; the RPC is
    // idempotent per user (PK on launch_promo_grants.user_id) so it
    // doesn't matter who calls it first. Previously this only ran from
    // the webhook — but verify almost always wins the race (Squad's
    // redirect lands ~1s before its webhook), and once verify flips the
    // status to 'completed' the webhook short-circuits without granting
    // the match. Net effect: first deposits silently missed the bonus.
    //
    // We pass the GROSS deposit (not post-spread) so the RPC's
    // min-deposit threshold lines up with the WalletModal copy that
    // says "Minimum deposit is ₦500" — depositing exactly ₦500 must
    // qualify, even though the 1% spread leaves ₦495 in the wallet.
    let welcomeCredit = 0;
    try {
      const { data: matchAmt } = await supabaseAdmin.rpc('claim_welcome_match', {
        p_user_id: userId,
        p_deposit_amount: amountInNGN,
      });
      welcomeCredit = Number(matchAmt || 0);
      if (welcomeCredit > 0) {
        await supabaseAdmin.from('treasury_log').insert([
          { type: 'welcome_match', amount_tngn: welcomeCredit, user_id: userId, metadata: { source: 'squad_card', transaction_ref: reference } },
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

    return NextResponse.json({ status: 'completed', amount: amountInNGN, tngn_credited: tNGNToCredit, welcomeMatchCredit: welcomeCredit });
  } catch (e: any) {
    console.error('Squad verify error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
