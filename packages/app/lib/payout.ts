// Pari-mutuel payout math for live "if you win" previews.
//
// Pool model (matches /api/markets/resolve):
//   1. Each bet's gross stake has an Entry Rake (1.5%) shaved before
//      entering the pool. The remainder is `net_stake`.
//   2. At resolution the platform takes a flat POOL RAKE (10%) of the
//      total pool. Everything else is split pro-rata among winners.
//      This is the "Pool Rake" that's quietly subtracted from what users
//      see — getDisplayPool() returns the post-rake number, and this
//      math computes their share of that same post-rake pool.
//
// For a *prospective* bet of `stake` on outcome `i` with current
// per-outcome net pools `pools[]`:
//   net           = stake * (1 - entry_rake_pct)
//   winningPool   = pools[i] + net
//   totalPool     = sum(pools) + net
//   payoutPool    = totalPool * (1 - pool_rake_pct)
//   yourShare     = net / winningPool
//   payout        = yourShare * payoutPool

export const ENTRY_RAKE_PCT = 0.015;
export const POOL_RAKE_PCT  = 0.10;

export interface PayoutPreview {
  payout: number;      // total tNGN returned if you win
  profit: number;      // payout - gross stake
  multiplier: number;  // payout / gross stake (e.g. 2.4x)
  impliedProb: number; // 0..1, current crowd probability of this outcome
  isFirstMover: boolean; // true if no one has staked the opposite side yet
}

export function calculatePotentialPayout(
  stake: number,
  pools: number[],
  selectedIndex: number,
): PayoutPreview | null {
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (selectedIndex < 0 || selectedIndex >= pools.length) return null;

  const safePools = pools.map(p => (Number.isFinite(p) && p > 0 ? p : 0));
  const net = stake * (1 - ENTRY_RAKE_PCT);
  const currentOutcome = safePools[selectedIndex];
  const totalCurrent = safePools.reduce((s, v) => s + v, 0);
  const losingCurrent = totalCurrent - currentOutcome;

  const winningPool = currentOutcome + net;
  const newTotal    = totalCurrent + net;
  const payoutPool  = newTotal * (1 - POOL_RAKE_PCT);

  const yourShare = net / winningPool;
  const payout    = yourShare * payoutPool;

  const impliedProb = totalCurrent > 0
    ? currentOutcome / totalCurrent
    : 1 / safePools.length;

  return {
    payout,
    profit: payout - stake,
    multiplier: payout / stake,
    impliedProb,
    // No one has staked against you yet — at resolution the market
    // would void & refund, so the preview is hypothetical.
    isFirstMover: losingCurrent <= 0,
  };
}
