/**
 * Row shapes for the Open Markets tables.
 *
 * These tables are new and are not in the generated Supabase `Database` types,
 * so a plain `.select()` comes back as an error type. Declaring the shapes in
 * one place keeps the money-facing routes type-checked instead of falling back
 * to `any` in three separate files — which is exactly how a column rename
 * becomes a runtime bug nobody catches.
 *
 * Numeric columns arrive as `number` over the wire but Postgres `numeric` can
 * serialise as a string for large values, so callers still coerce with
 * Number() at the point of use.
 */

export type OpenMarketRow = {
  id: string;
  question: string;
  description: string | null;
  category: string;
  outcomes: string[];
  q: number[];
  q_initial: number[];
  b: number;
  status: string;
  resolution_source: string;
  resolution_detail: string | null;
  horizon_at: string | null;
  horizon_count: number;
  horizon_window_closes_at: string | null;
  trading_closes_at: string | null;
  resolved_outcome: number | null;
  dispute_window_hours: number;
  settlement_locked_until: string | null;
  fees_collected: number;
  created_by: string | null;
  opened_at: string | null;
  resolved_at: string | null;
};

/** The subset the browse list needs — deliberately narrower than the full row. */
export type OpenMarketListRow = Pick<OpenMarketRow,
  'id' | 'question' | 'description' | 'category' | 'outcomes' | 'q' | 'b' |
  'status' | 'horizon_at' | 'trading_closes_at' | 'fees_collected' | 'opened_at'
> & { created_at: string };

export type OpenPositionRow = {
  id: string;
  market_id: string;
  user_id: string;
  outcome_idx: number;
  shares_cash: number;
  shares_bonus: number;
  cost_cash: number;
  cost_bonus: number;
  status: string;
  settled_at: string | null;
};

/**
 * Outcome prices from the share quantities. Mirrors lmsr_prices() in SQL.
 *
 * Uses the same log-sum-exp form as the database: subtracting the max keeps
 * every exponent <= 0, so exp() can never overflow to Infinity. A naive
 * exp(q/b) returns Infinity past ~709 and the resulting NaN would render as a
 * blank or nonsensical probability on every card.
 *
 * Display only. Never price a trade with this — the executing RPC recomputes
 * under a row lock, and anything computed here is stale the moment it is sent.
 */
export function pricesFromQ(q: number[] | string[], b: number | string): number[] {
  const bb = Number(b);
  const qs = (q as any[]).map(Number);
  const max = Math.max(...qs);
  const exps = qs.map(x => Math.exp((x - max) / bb));
  const total = exps.reduce((s, e) => s + e, 0);
  return exps.map(e => e / total);
}

/**
 * Public activity signal. Fees are a fixed 1.5% of trade value, so dividing
 * back out gives volume without exposing any individual's flow — open_trades
 * is owner-only at the RLS layer precisely so one account's naira amounts are
 * never readable by another.
 */
export function volumeFromFees(feesCollected: number | string): number {
  return Math.round(Number(feesCollected || 0) / 0.015);
}
