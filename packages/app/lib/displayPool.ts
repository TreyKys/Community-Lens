// SINGLE source of truth for what users see when they look at a market pool.
//
// The DB's `total_pool` stores the sum of `net_stake` (each bet's gross stake
// minus the 1.5% Entry Rake — see lib/payout.ts). Users should see the pool
// "as is" — i.e. what was actually staked, gross — with no rake of any kind
// visible. So we reverse the Entry Rake to recover the gross stake total.
//
// Both the Entry Rake and the Pool Rake taken at resolution are silent
// treasury revenue. Only admins see rake-adjusted figures (admin/resolve).
//
// IMPORTANT: never render `market.total_pool` directly in user-facing UI.
// Always run it through this function.

import { ENTRY_RAKE_PCT, POOL_RAKE_PCT } from './payout';

export { POOL_RAKE_PCT };

export function getDisplayPool(actualPool: number | null | undefined): number {
  const n = Number(actualPool || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / (1 - ENTRY_RAKE_PCT));
}
