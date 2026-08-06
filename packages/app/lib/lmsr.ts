/**
 * LMSR (Logarithmic Market Scoring Rule) — pricing core for Open Markets.
 *
 * Pure functions only. No I/O, no database, no wallet. The atomic trade RPC
 * calls into this; every money movement happens in SQL under a row lock.
 *
 * ── Why this file is written the way it is ─────────────────────────────────
 * An adversarial review of the Open Markets spec found that a naive LMSR
 * implementation is exploitable in at least five distinct ways. Each guard
 * below exists because of a specific, quantified attack, and each has a
 * matching regression test in lmsr.test.ts:
 *
 *   1. exp(q/b) overflows to Infinity at realistic q, handing out free
 *      positions. → log-sum-exp, always.
 *   2. Rounding in the user's favour is farmable by micro-trades.
 *      → all rounding is house-favourable, and money is integer kobo.
 *   3. A 1.5% fee on a tiny trade rounds to zero, and LMSR is
 *      path-independent, so N micro-trades cost the same as one big one —
 *      i.e. the entire fee (the only thing funding the subsidy) is avoidable
 *      by subdivision. → minimum trade size AND minimum fee.
 *   4. Selling shares you don't hold is borrowing from the house; the
 *      proceeds asymptote to b·ln(N) but the liability is linear, so house
 *      loss is unbounded (13x the "hard bound" at 100k shares).
 *      → shares can never go negative; enforced here and by a CHECK.
 *   5. Buying D of EVERY outcome costs exactly D and pays exactly D — a
 *      perfect risk-free hedge. Harmless on its own, catastrophic if two
 *      funding sources have different withdrawal rights. → the caller must
 *      refuse complete sets; wouldFormCompleteSet() exposes the check.
 */

/** Money is integer kobo everywhere. 100 kobo = ₦1. A share pays ₦1 = 100 kobo. */
export const KOBO_PER_NAIRA = 100;

/** Fee on every trade, charged on trade value. Matches the existing entry rake. */
export const TRADE_FEE_PCT = 0.015;

/**
 * Minimum gross trade, in kobo (₦100). Two jobs: it stops sub-kobo dust
 * trades, and it keeps the fee well clear of the rounding floor so fee
 * revenue cannot be avoided by subdivision (attack 3).
 */
export const MIN_TRADE_KOBO = 100 * KOBO_PER_NAIRA;

/** Fee floor in kobo. Belt and braces alongside MIN_TRADE_KOBO. */
export const MIN_FEE_KOBO = 1;

export interface Quote {
  /** Signed share delta. Positive = buy, negative = sell. */
  deltaShares: number;
  /** Pre-fee cost in kobo. Positive = user pays, negative = user receives. */
  costKobo: number;
  /** Fee in kobo. Always positive, always charged. */
  feeKobo: number;
  /**
   * What actually leaves (positive) or enters (negative) the wallet, in kobo.
   * THIS is the number a slippage guard must be compared against — not
   * costKobo — or every user's guard is systematically 1.5% looser than they
   * think it is.
   */
  totalKobo: number;
  /** Average price per share, in kobo. For display. */
  avgPriceKobo: number;
  /** Outcome prices after this trade executes. Sum to 1. */
  pricesAfter: number[];
}

/**
 * Liquidity parameter from a target worst-case exposure.
 *
 * Max house loss is b·ln(N), so a fixed b means a 10-outcome market risks
 * 3.3x what a binary one does. Fixing the EXPOSURE and deriving b keeps every
 * market in a tier inside the same budget regardless of outcome count.
 */
export function bFromExposure(targetExposureNaira: number, outcomeCount: number): number {
  if (outcomeCount < 2) throw new Error('a market needs at least 2 outcomes');
  return targetExposureNaira / Math.log(outcomeCount);
}

/** Maximum the house can ever lose on this market, in naira. A hard bound. */
export function maxSubsidyNaira(b: number, outcomeCount: number): number {
  return b * Math.log(outcomeCount);
}

/**
 * Expected — not worst-case — house subsidy, in naira.
 *
 * The spec originally assumed "40% of worst case". The true expectation is
 * b·(ln N − H(p_final)): the entropy the market actually resolves. Markets
 * that settle get arbitraged to 0.95–0.999 first, so realised subsidy is
 * 71–99% of the bound, not 40%. Markets that never resolve stay diffuse and
 * cost far less. Budget the two separately — they are different products.
 */
export function expectedSubsidyNaira(b: number, finalPrices: number[]): number {
  const n = finalPrices.length;
  const H = -finalPrices.reduce((s, p) => (p > 0 ? s + p * Math.log(p) : s), 0);
  return b * (Math.log(n) - H);
}

/**
 * Cost function C(q) = b·ln(Σ exp(qᵢ/b)), in naira.
 *
 * Computed via log-sum-exp. A direct exp(q/b) silently returns Infinity for
 * q/b above ~709, which on a busy market is reachable — and Infinity − Infinity
 * is NaN, which a naive caller would treat as a free trade.
 */
export function lmsrCost(q: number[], b: number): number {
  if (b <= 0) throw new Error('b must be positive');
  const m = Math.max(...q);
  const sum = q.reduce((s, qi) => s + Math.exp((qi - m) / b), 0);
  return m + b * Math.log(sum);
}

/** Outcome prices. Always sum to exactly 1 (up to float epsilon). */
export function lmsrPrices(q: number[], b: number): number[] {
  const m = Math.max(...q);
  const exps = q.map(qi => Math.exp((qi - m) / b));
  const total = exps.reduce((s, e) => s + e, 0);
  return exps.map(e => e / total);
}

/** Raw, unrounded, unfeed cost of moving the book, in naira. */
export function rawTradeCost(q: number[], b: number, outcomeIdx: number, deltaShares: number): number {
  if (outcomeIdx < 0 || outcomeIdx >= q.length) throw new Error('outcome index out of range');
  const next = [...q];
  next[outcomeIdx] += deltaShares;
  return lmsrCost(next, b) - lmsrCost(q, b);
}

/**
 * Round a SIGNED naira cost to kobo, always against the user.
 *
 * ceil() is correct in both directions, which is not obvious:
 *   • buy  → cost is positive; ceil makes the user pay MORE.
 *   • sell → cost is negative; ceil moves it toward zero, so the magnitude
 *            the user RECEIVES gets smaller.
 *
 * Flooring a sell does the opposite — floor(−99296.35) = −99297 hands the
 * user a fraction more than the curve owes them, on every single sell. The
 * first version of this file had exactly that bug; the round-trip property
 * test caught it.
 */
const toKoboHouseFavourable = (naira: number) => Math.ceil(naira * KOBO_PER_NAIRA - 1e-9);

/**
 * Round a payout the user RECEIVES (always positive) down to whole kobo.
 * Distinct from the signed helper above: here the sign is known, so flooring
 * is what keeps the residual with the house and guarantees a distribution can
 * never exceed the pool it is dividing.
 */
const payoutKoboFloor = (naira: number) => Math.floor(naira * KOBO_PER_NAIRA + 1e-9);

/**
 * Price a trade, with every guard applied.
 *
 * Rounding is ALWAYS against the user — cost up on a buy, proceeds down on a
 * sell, fee up in both directions. The residual accrues to the house, never
 * the trader, so no amount of trade-splitting extracts value.
 *
 * @param currentShares the user's existing holding of this outcome. Required:
 *        a sell that would take it negative is naked shorting, which makes
 *        house loss unbounded rather than capped at b·ln(N).
 */
export function quoteTrade(
  q: number[],
  b: number,
  outcomeIdx: number,
  deltaShares: number,
  currentShares: number,
): Quote {
  if (!Number.isFinite(deltaShares) || deltaShares === 0) {
    throw new Error('deltaShares must be a non-zero finite number');
  }
  // Attack 4: no naked shorts, ever.
  if (deltaShares < 0 && currentShares + deltaShares < -1e-9) {
    throw new Error('cannot sell more shares than held (naked short)');
  }

  const raw = rawTradeCost(q, b, outcomeIdx, deltaShares);
  const isBuy = deltaShares > 0;

  // House-favourable in both directions — see toKoboHouseFavourable.
  const costKobo = toKoboHouseFavourable(raw);
  const grossKobo = Math.abs(costKobo);

  // Attack 3: below the minimum, the fee rounds toward nothing and
  // path-independence lets a trader subdivide their way out of paying it.
  if (grossKobo < MIN_TRADE_KOBO) {
    throw new Error(`trade below minimum of ₦${MIN_TRADE_KOBO / KOBO_PER_NAIRA}`);
  }

  const feeKobo = Math.max(Math.ceil(grossKobo * TRADE_FEE_PCT - 1e-9), MIN_FEE_KOBO);

  // Buy: user pays cost + fee. Sell: user receives proceeds − fee.
  const totalKobo = isBuy ? costKobo + feeKobo : costKobo + feeKobo;

  const next = [...q];
  next[outcomeIdx] += deltaShares;

  return {
    deltaShares,
    costKobo,
    feeKobo,
    totalKobo,
    avgPriceKobo: Math.abs(costKobo) / Math.abs(deltaShares),
    pricesAfter: lmsrPrices(next, b),
  };
}

/**
 * Would this trade leave the user holding every outcome — a complete set?
 *
 * A complete set costs exactly its payout, so it is a risk-free instrument.
 * That is fine when one currency is in play and fatal when two are: fund the
 * losing leg with restricted bonus and the winning leg with cash, and the
 * pair converts bonus to withdrawable cash at ~98% for the price of the fee,
 * with no prediction involved. The trade RPC must reject these outright.
 */
export function wouldFormCompleteSet(
  heldShares: number[],
  outcomeIdx: number,
  deltaShares: number,
): boolean {
  if (deltaShares <= 0) return false;
  const after = [...heldShares];
  after[outcomeIdx] += deltaShares;
  return after.every(s => s > 0);
}

/**
 * Unwind a whole book fairly — for horizon cash-out, auto-retire and void.
 *
 * Paying every holder a single snapshot price is a riskless drain: by
 * convexity of C, p·q ≥ C(q) − C(0), and the gap is the entire LMSR subsidy,
 * handed out with no outcome risk and repeatable every horizon. Paying
 * sequentially instead is house-neutral but order-dependent — the first
 * seller gets ~2x the last, which is a bank run with a public leaderboard.
 *
 * This distributes exactly what the book collected, pro rata by position
 * value. Order-independent, house-neutral, no stampede.
 *
 * @returns payout in kobo per holder, in the order given.
 */
export function proRataUnwind(
  q: number[],
  qInitial: number[],
  b: number,
  holders: { outcomeIdx: number; shares: number }[],
): number[] {
  const pool = lmsrCost(q, b) - lmsrCost(qInitial, b); // exactly what was collected
  const prices = lmsrPrices(q, b);
  const weights = holders.map(h => h.shares * prices[h.outcomeIdx]);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return holders.map(() => 0);
  // Floor each payout: the rounding residual stays with the house, so the
  // distribution can never exceed the pool.
  return weights.map(w => payoutKoboFloor((pool * w) / totalWeight));
}
