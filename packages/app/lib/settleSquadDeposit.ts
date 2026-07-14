import type { SupabaseClient } from '@supabase/supabase-js';

// Credit a confirmed-paid Squad deposit, atomically where possible.
//
// Preferred path: the settle_squad_deposit RPC (migration 20260712000000)
// does the whole credit in one transaction. But if that migration hasn't
// been applied yet, calling a missing function would fail EVERY deposit —
// a far worse regression than the bug it fixes. So this helper detects a
// missing-function error and falls back to an inline credit that is still
// idempotent and double-credit-safe (ledger anchor + a status CAS to
// serialize concurrent callers), just not single-transaction atomic.
//
// Once the migration is applied, the RPC path is used automatically.
// Callers must have confirmed the payment succeeded with Squad first.

const SPREAD_PCT = 0.01;

export type SettleOutcome = 'credited' | 'already_credited' | 'needs_review' | 'not_found' | 'pending';

export interface SettleResult {
  outcome: SettleOutcome;
  tngnCredited: number;
  spread: number;
  error?: string;
}

function isMissingFunction(err: any): boolean {
  const code = err?.code;
  const msg = String(err?.message || '').toLowerCase();
  // 42883 = undefined_function (Postgres); PGRST202 = PostgREST "could not
  // find the function". Either means the migration isn't applied yet.
  return code === '42883' || code === 'PGRST202' ||
    msg.includes('could not find the function') ||
    (msg.includes('function') && msg.includes('does not exist'));
}

export async function settleSquadDeposit(
  db: SupabaseClient,
  transactionRef: string,
  amountNgn: number,
): Promise<SettleResult> {
  const spread = amountNgn * SPREAD_PCT;
  const credit = amountNgn - spread;

  // ── Preferred: atomic RPC ─────────────────────────────────────────
  const { data, error } = await db.rpc('settle_squad_deposit', {
    p_transaction_ref: transactionRef,
    p_amount_ngn: amountNgn,
  });
  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    return {
      outcome: (row?.outcome as SettleOutcome) || 'pending',
      tngnCredited: Number(row?.tngn_credited ?? credit),
      spread: Number(row?.spread_captured ?? spread),
    };
  }
  if (!isMissingFunction(error)) {
    // A real runtime error (e.g. user missing). Surface it — the row is
    // provably uncredited because the RPC is one transaction that rolled
    // back. Caller decides the HTTP status; the deposit stays retriable.
    return { outcome: 'pending', tngnCredited: credit, spread, error: (error as any)?.code || error.message };
  }

  // ── Fallback: migration not applied — idempotent inline credit ────
  // 1. Ledger anchor: already credited?
  const { data: ledger } = await db
    .from('treasury_movements')
    .select('id')
    .eq('reference', transactionRef)
    .eq('type', 'deposit')
    .eq('gateway', 'squad')
    .limit(1)
    .maybeSingle();
  if (ledger) {
    await db.from('squad_transactions').update({ status: 'completed' }).eq('transaction_ref', transactionRef);
    return { outcome: 'already_credited', tngnCredited: credit, spread };
  }

  // 2. CAS-claim so only one caller credits. Provably-uncredited states
  //    only; 'crediting' is deliberately excluded (ambiguous).
  const { data: claimed } = await db
    .from('squad_transactions')
    .update({ status: 'crediting', tngn_credited: credit, spread_captured: spread })
    .eq('transaction_ref', transactionRef)
    .in('status', ['awaiting_payment', 'pending', 'failed_balance_update'])
    .select('user_id')
    .maybeSingle();

  if (!claimed) {
    // Didn't win the claim. Either another caller is mid-credit, the row
    // is 'crediting'/'completed', or it doesn't exist. Re-check the ledger
    // to decide; never credit here (that's what avoids the double).
    const { data: ledger2 } = await db
      .from('treasury_movements')
      .select('id')
      .eq('reference', transactionRef)
      .eq('type', 'deposit')
      .eq('gateway', 'squad')
      .limit(1)
      .maybeSingle();
    if (ledger2) return { outcome: 'already_credited', tngnCredited: credit, spread };
    const { data: exists } = await db
      .from('squad_transactions')
      .select('status')
      .eq('transaction_ref', transactionRef)
      .maybeSingle();
    if (!exists) return { outcome: 'not_found', tngnCredited: credit, spread };
    // In-flight elsewhere or ambiguous 'crediting' — let a retry/cron handle it.
    return { outcome: exists.status === 'crediting' ? 'needs_review' : 'pending', tngnCredited: credit, spread };
  }

  const userId = (claimed as any).user_id as string | null;

  // 3. Credit. On failure, revert to a RECLAIMABLE state so a retry can
  //    recover it (unlike the old code which stranded it).
  const { error: creditErr } = await db.rpc('credit_user', {
    p_user_id: userId,
    p_tngn_delta: credit,
    p_bonus_delta: 0,
  });
  if (creditErr) {
    await db.from('squad_transactions').update({ status: 'failed_balance_update' }).eq('transaction_ref', transactionRef);
    return { outcome: 'pending', tngnCredited: credit, spread, error: (creditErr as any)?.code || creditErr.message };
  }

  // 4. Ledger (the idempotency record) + complete.
  await db.from('treasury_movements').insert([
    { user_id: userId, type: 'deposit', gateway: 'squad', direction: 'in', amount_ngn: amountNgn, reference: transactionRef },
    { user_id: userId, type: 'spread', gateway: 'squad', direction: 'in', amount_ngn: spread, reference: transactionRef },
  ]);
  await db.from('squad_transactions').update({ status: 'completed' }).eq('transaction_ref', transactionRef);

  return { outcome: 'credited', tngnCredited: credit, spread };
}
