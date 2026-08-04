// The spend guard.
//
// X's API is metered now, and the things that call it are unattended
// cron jobs. That combination is how a bug becomes a bill: a retry loop
// that reads a timeline 400 times costs $2 in twenty minutes and nobody
// finds out until the card is charged.
//
// So every metered call goes through reserve() first. It:
//   1. sums month-to-date spend from the ledger,
//   2. refuses if this call would cross the cap,
//   3. writes the ledger row BEFORE the call goes out.
//
// Writing before means a crash mid-flight over-counts rather than
// under-counts. Over-counting costs us a few posts at the end of a
// month; under-counting costs real money, and only one of those two
// errors is recoverable.
//
// Set a spend cap in X's developer portal as well. This module is the
// thing that keeps us away from that cap; the portal cap is what saves
// us if this module has a bug.

import { getSupabaseAdmin } from '@/lib/oracle';
import { effectiveOperation, estimateCost, usdToNgn, type XOperation } from './cost';

/** Monthly ceiling in USD. ₦10,000 at ~₦1,550/$ is about $6.45. */
export function monthlyCapUsd(): number {
  const raw = Number(process.env.SOCIAL_MONTHLY_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 6.5;
}

export type Reservation =
  | { ok: true; usdCost: number; spentUsd: number; remainingUsd: number }
  | { ok: false; reason: string; spentUsd: number; remainingUsd: number };

export async function spentThisMonthUsd(): Promise<number> {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa.rpc('social_spend_mtd');
  if (error) {
    // Fail CLOSED. If we cannot read the ledger we do not know what we
    // have spent, and guessing "probably fine" is how the bill happens.
    throw new Error(`social budget: cannot read spend ledger — ${error.message}`);
  }
  return Number(data ?? 0);
}

/**
 * Reserve budget for one metered call. Returns ok:false when the call
 * would take us past the cap — callers must treat that as "stop", not
 * "retry".
 */
export async function reserve(
  op: XOperation,
  opts: { units?: number; body?: string; refTable?: string; refId?: number } = {},
): Promise<Reservation> {
  const { units = 1, body, refTable, refId } = opts;

  const usdCost = estimateCost(op, units, body);
  const cap = monthlyCapUsd();
  const spent = await spentThisMonthUsd();
  const remaining = Number((cap - spent).toFixed(5));

  if (spent + usdCost > cap) {
    return {
      ok: false,
      reason:
        `monthly X budget exhausted — $${spent.toFixed(3)} of $${cap.toFixed(2)} spent ` +
        `(₦${usdToNgn(spent)} of ₦${usdToNgn(cap)}); this ${op} needs $${usdCost.toFixed(3)}`,
      spentUsd: spent,
      remainingUsd: remaining,
    };
  }

  const supa = getSupabaseAdmin();
  const { error } = await supa.from('social_spend').insert({
    operation: effectiveOperation(op, body),
    units,
    usd_cost: usdCost,
    ref_table: refTable ?? null,
    ref_id: refId ?? null,
  });

  if (error) {
    // Could not record the debit, so do not make the call. An unrecorded
    // spend is invisible to every future guard.
    return {
      ok: false,
      reason: `could not write spend ledger — ${error.message}`,
      spentUsd: spent,
      remainingUsd: remaining,
    };
  }

  return {
    ok: true,
    usdCost,
    spentUsd: Number((spent + usdCost).toFixed(5)),
    remainingUsd: Number((remaining - usdCost).toFixed(5)),
  };
}

/**
 * Give back a reservation when the call never actually happened — an X
 * 4xx that bills nothing, or a local guard rejecting before the request.
 * Recorded as a compensating negative row rather than a delete, so the
 * ledger stays append-only and auditable.
 */
export async function refund(op: XOperation, units = 1, body?: string): Promise<void> {
  const usdCost = estimateCost(op, units, body);
  const supa = getSupabaseAdmin();
  await supa.from('social_spend').insert({
    operation: `refund_${effectiveOperation(op, body)}`,
    units,
    usd_cost: -usdCost,
    ref_table: null,
    ref_id: null,
  });
}

/** Operator-facing summary, used by the Telegram digest and /api/social/status. */
export async function budgetSummary() {
  const cap = monthlyCapUsd();
  const spent = await spentThisMonthUsd();
  return {
    capUsd: cap,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number((cap - spent).toFixed(4)),
    capNgn: usdToNgn(cap),
    spentNgn: usdToNgn(spent),
    remainingNgn: usdToNgn(cap - spent),
    pctUsed: cap > 0 ? Math.round((spent / cap) * 100) : 0,
  };
}
