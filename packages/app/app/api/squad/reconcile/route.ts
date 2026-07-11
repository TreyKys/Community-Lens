import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyTransaction } from '@/lib/squad';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/squad/reconcile   (cron-secret gated)
//
// The safety net for "charged but not credited". The redirect-verify
// path only credits if the user's browser actually returns to the
// callback page, and the webhook only credits if it's delivered — on
// mobile card/USSD, one or both routinely don't happen, stranding a
// paid deposit as 'awaiting_payment' forever. This sweep re-verifies
// every stuck deposit against Squad's own /transaction/verify and
// credits the confirmed-paid ones through the same atomic RPC the live
// paths use, so a missed webhook + closed tab is no longer permanent.
//
// This is the single biggest lever for pushing the failure rate from
// ~1/10 toward <1/100: even if BOTH live paths miss, this heals it
// within one cron interval.
//
// Runs every few minutes via .github/workflows/cron-squad-reconcile.yml.

// Only touch rows old enough that the live paths have had their chance
// (a just-created row is still mid-checkout), but recent enough to be a
// real in-flight deposit rather than an ancient abandoned attempt.
const MIN_AGE_MINUTES = 3;
const MAX_AGE_DAYS = 3;
// After this long with Squad still not confirming payment, an
// 'awaiting_payment' row is a genuinely abandoned checkout — stop
// re-verifying it so the sweep doesn't hammer Squad forever.
const ABANDON_AFTER_HOURS = 6;
const BATCH = 50;

// States the sweep may safely act on: each is provably-uncredited under
// the old flow (see migration 20260712000000). 'crediting' is
// deliberately EXCLUDED — it's the one ambiguous state, handled as
// needs_review by the RPC and surfaced for manual admin review instead.
const RECOVERABLE_STATES = ['awaiting_payment', 'pending', 'failed_balance_update'];

function isSuccessful(squadData: any): boolean {
  const s = String(
    squadData?.transaction_status || squadData?.gateway_response || squadData?.status || '',
  ).toLowerCase();
  return s === 'successful' || s === 'success';
}

export async function POST(request: Request) {
  if (request.headers.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = Date.now();
  const notBefore = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const notAfter = new Date(now - MIN_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: stuck, error } = await supabaseAdmin
    .from('squad_transactions')
    .select('transaction_ref, user_id, amount_ngn, status, created_at')
    .in('status', RECOVERABLE_STATES)
    .gte('created_at', notBefore)
    .lte('created_at', notAfter)
    .order('created_at', { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error('reconcile: query failed', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = { scanned: (stuck || []).length, credited: 0, stillPending: 0, abandoned: 0, needsReview: 0, errored: 0 };

  for (const row of stuck || []) {
    try {
      let squadData: any;
      try {
        squadData = await verifyTransaction(row.transaction_ref);
      } catch (e: any) {
        // Squad API hiccup — leave the row for the next run.
        results.errored += 1;
        continue;
      }

      if (isSuccessful(squadData)) {
        const { data: settleRows, error: settleErr } = await supabaseAdmin.rpc('settle_squad_deposit', {
          p_transaction_ref: row.transaction_ref,
          p_amount_ngn: row.amount_ngn,
        });
        if (settleErr) { results.errored += 1; continue; }
        const outcome = (Array.isArray(settleRows) ? settleRows[0] : settleRows)?.outcome;
        if (outcome === 'credited') {
          results.credited += 1;
          // Fresh credit via the sweep — notify the user, mirroring the
          // live paths (extras are gated on 'credited' so no duplicates).
          const credited = row.amount_ngn - row.amount_ngn * 0.01;
          await supabaseAdmin.from('treasury_log').insert([
            { type: 'deposit_spread', amount_tngn: row.amount_ngn * 0.01, user_id: row.user_id, metadata: { source: 'squad_reconcile', transaction_ref: row.transaction_ref } },
          ]).then(() => undefined, () => undefined);
          await supabaseAdmin.from('notifications').insert({
            user_id: row.user_id,
            type: 'deposit_credited',
            message: `Deposit received — ₦${Math.round(credited).toLocaleString()} added to your wallet. Ready to predict.`,
            amount: credited,
          }).then(() => undefined, () => undefined);
        } else if (outcome === 'needs_review') {
          results.needsReview += 1;
        } else {
          // already_credited — the row just hadn't been marked done.
          results.credited += 0;
        }
      } else {
        // Squad says not successful. If it's been sitting unpaid long
        // enough, mark it abandoned so we stop re-checking; otherwise
        // leave it — the user may still be completing payment.
        const ageHours = (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
        if (row.status === 'awaiting_payment' && ageHours >= ABANDON_AFTER_HOURS) {
          await supabaseAdmin
            .from('squad_transactions')
            .update({ status: 'abandoned' })
            .eq('transaction_ref', row.transaction_ref)
            .eq('status', 'awaiting_payment'); // don't clobber a concurrent credit
          results.abandoned += 1;
        } else {
          results.stillPending += 1;
        }
      }
    } catch (e: any) {
      console.error('reconcile: row failed', row.transaction_ref, e?.message || e);
      results.errored += 1;
    }
  }

  return NextResponse.json({ ok: true, ...results });
}
