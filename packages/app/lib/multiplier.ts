/**
 * lib/multiplier.ts
 *
 * Pure math for Multiplier slips (parlays). A slip is N legs across N
 * DIFFERENT markets; the user must be right on every leg to win.
 *
 * DESIGN: fixed combined odds at placement.
 *   - Each leg locks its FLOOR odds (the server-guaranteed minimum the
 *     single-bet engine already produces) at the moment the slip is
 *     placed. This is exactly how a Sportybet parlay works: odds are
 *     frozen when you submit, the ticket pays stake × product(odds).
 *   - We do NOT give multiplier legs the per-leg parimutuel upside that
 *     singles get. A parlay leg isn't in a pool the way a single is
 *     (the slip stake never enters any market's pool — a parlay is
 *     house-vs-user), so there's nothing to "fill". Fixed odds is the
 *     honest, familiar, and simpler model.
 *
 * The vig compounding per leg is the house's edge: a 5-leg slip at ~8%
 * vig/leg keeps ~30% of turnover; a 10-leg keeps ~50%. We never need to
 * shade payouts — the structure does the work. See the locked-odds spec.
 *
 * Pure functions. No I/O. Exhaustively unit-tested in multiplier.test.ts.
 */

import { TIER2_MIN_STAKE, ENTRY_RAKE_PCT, MAX_ODDS } from './lockedOdds';

// ─── Public constants ────────────────────────────────────────────────

/** Fewest legs that make a slip a "multiplier" rather than a single. */
export const MULT_MIN_LEGS = 2;

/** Max legs by tier. Slip tier is from the SLIP stake, not per-leg. */
export const MULT_MAX_LEGS_TIER1 = 5;
export const MULT_MAX_LEGS_TIER2 = 10;

/**
 * A leg must price at least this to be eligible. Stops users stuffing a
 * slip with 1.01× near-certainties to farm Boosts / grind a guaranteed
 * combined return. 1.20× forces every leg to carry real risk.
 */
export const MULT_MIN_LEG_ODDS = 1.20;

/**
 * The combined product must clear this. Blocks risk-free arbitrage and
 * keeps slips in "real parlay" territory rather than a dressed-up single.
 */
export const MULT_MIN_COMBINED_ODDS = 3.0;

/**
 * Absolute payout ceiling per slip (T&C disclosed). Caps the house's
 * tail liability on a monster multiplier. If product × stake would
 * exceed this, the effective combined multiplier is trimmed so payout
 * lands exactly here.
 */
export const MULT_MAX_PAYOUT_TNGN = 200_000;

/** Minimum slip stake. Below TIER2_MIN_STAKE the slip is Tier 1. */
export const MULT_MIN_SLIP_STAKE = 100;

// ─── Types ───────────────────────────────────────────────────────────

/**
 * A leg as the user is building / placing the slip. lockedOdds is the
 * leg's FLOOR multiplier from calculateLockedOdds at placement time.
 */
export interface SlipLegInput {
  marketId: number;
  outcomeIndex: number;
  lockedOdds: number;
  vigAtStakePct: number;
}

export interface SlipValidationResult {
  ok: boolean;
  /** Machine-readable reason; maps to a friendly message at the edge. */
  error?:
    | 'too_few_legs'
    | 'too_many_legs'
    | 'duplicate_event'
    | 'leg_below_min_odds'
    | 'combined_below_min'
    | 'stake_below_min';
  /** Human context for the error (e.g. which leg). */
  detail?: string;
}

export interface SlipQuote {
  tier: 1 | 2;
  netSlipStake: number;
  entryRakeTngn: number;
  /** Product of leg floor odds, rounded to 2dp. */
  combinedOdds: number;
  /**
   * Effective combined odds AFTER the max-payout cap is applied. Equal
   * to combinedOdds unless the slip would breach MULT_MAX_PAYOUT_TNGN.
   */
  effectiveCombinedOdds: number;
  /** netSlipStake × effectiveCombinedOdds, rounded. The "if all correct". */
  payoutTngn: number;
  /** True if the payout cap trimmed the combined odds. */
  capBound: boolean;
}

/** Per-leg settlement outcome as its market resolves. */
export type LegSettlement =
  | { result: 'won'; realizedOdds: number }
  | { result: 'lost' }
  | { result: 'void' }; // postponed/voided market → leg becomes 1.0×

// ─── Tier ────────────────────────────────────────────────────────────

export function slipTier(slipStake: number): 1 | 2 {
  return slipStake < TIER2_MIN_STAKE ? 1 : 2;
}

export function maxLegsForTier(tier: 1 | 2): number {
  return tier === 1 ? MULT_MAX_LEGS_TIER1 : MULT_MAX_LEGS_TIER2;
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate a slip's legs + stake. Pure — does NOT check market state
 * (open/closed); the placement RPC does that atomically per leg.
 *
 * one-leg-per-event: enforced here via marketId uniqueness. In base
 * mode (Phase 7) a slip cannot contain two legs from the same market.
 * SGP (Phase 9) will relax this with correlation guardrails.
 */
export function validateSlip(legs: SlipLegInput[], slipStake: number): SlipValidationResult {
  if (!Number.isFinite(slipStake) || slipStake < MULT_MIN_SLIP_STAKE) {
    return { ok: false, error: 'stake_below_min', detail: `min ₦${MULT_MIN_SLIP_STAKE}` };
  }

  const tier = slipTier(slipStake);
  const maxLegs = maxLegsForTier(tier);

  if (legs.length < MULT_MIN_LEGS) {
    return { ok: false, error: 'too_few_legs', detail: `min ${MULT_MIN_LEGS} legs` };
  }
  if (legs.length > maxLegs) {
    return { ok: false, error: 'too_many_legs', detail: `max ${maxLegs} legs at this stake` };
  }

  // One leg per event.
  const seen = new Set<number>();
  for (const leg of legs) {
    if (seen.has(leg.marketId)) {
      return { ok: false, error: 'duplicate_event', detail: `market ${leg.marketId} appears twice` };
    }
    seen.add(leg.marketId);
  }

  // Min per-leg odds.
  for (const leg of legs) {
    if (!Number.isFinite(leg.lockedOdds) || leg.lockedOdds < MULT_MIN_LEG_ODDS) {
      return { ok: false, error: 'leg_below_min_odds', detail: `market ${leg.marketId} at ${leg.lockedOdds}×` };
    }
  }

  // Min combined.
  const combined = rawCombinedOdds(legs);
  if (combined < MULT_MIN_COMBINED_ODDS) {
    return { ok: false, error: 'combined_below_min', detail: `${combined.toFixed(2)}× < ${MULT_MIN_COMBINED_ODDS}×` };
  }

  return { ok: true };
}

// ─── Odds combination ────────────────────────────────────────────────

/** Raw product of leg odds (no rounding, no cap). Internal. */
function rawCombinedOdds(legs: Pick<SlipLegInput, 'lockedOdds'>[]): number {
  return legs.reduce((acc, leg) => acc * leg.lockedOdds, 1);
}

/** Deterministic 2dp rounding — display == settlement. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Quote a slip: combined odds, cap handling, net stake, payout. Assumes
 * validateSlip already passed (callers should validate first), but is
 * defensive enough not to produce NaN on degenerate inputs.
 */
export function quoteSlip(legs: SlipLegInput[], slipStake: number): SlipQuote {
  const tier = slipTier(slipStake);
  const entryRakeTngn = round2(slipStake * ENTRY_RAKE_PCT);
  const netSlipStake = slipStake - entryRakeTngn;

  const combinedOdds = round2(rawCombinedOdds(legs));

  // Max-payout cap. If net × combined would exceed the ceiling, trim
  // the effective combined so payout lands at-or-just-under the cap.
  // We FLOOR the trimmed odds to 2dp (not round) so the resulting
  // payout can never round back UP over the ceiling — the cap is a
  // hard limit the house must never breach.
  let effectiveCombinedOdds = combinedOdds;
  let capBound = false;
  const uncappedPayout = netSlipStake * combinedOdds;
  if (uncappedPayout > MULT_MAX_PAYOUT_TNGN && netSlipStake > 0) {
    effectiveCombinedOdds = Math.floor((MULT_MAX_PAYOUT_TNGN / netSlipStake) * 100) / 100;
    capBound = true;
  }

  // Final clamp is belt-and-braces: even with floored odds, guarantee
  // the integer payout is <= the cap.
  const payoutTngn = Math.min(MULT_MAX_PAYOUT_TNGN, Math.round(netSlipStake * effectiveCombinedOdds));

  return {
    tier,
    netSlipStake,
    entryRakeTngn,
    combinedOdds,
    effectiveCombinedOdds,
    payoutTngn,
    capBound,
  };
}

// ─── Settlement ──────────────────────────────────────────────────────

/**
 * Resolve a single leg given its market's outcome.
 *
 *   - winning index matches the leg pick  → won at its locked floor odds
 *   - market voided                       → leg void (treated as 1.0×)
 *   - otherwise                           → lost (the whole slip dies)
 */
export function settleLeg(
  leg: Pick<SlipLegInput, 'outcomeIndex' | 'lockedOdds'>,
  marketOutcome: { winningOutcomeIndex: number | null; voided: boolean },
): LegSettlement {
  if (marketOutcome.voided || marketOutcome.winningOutcomeIndex === null) {
    return { result: 'void' };
  }
  if (leg.outcomeIndex === marketOutcome.winningOutcomeIndex) {
    return { result: 'won', realizedOdds: leg.lockedOdds };
  }
  return { result: 'lost' };
}

/**
 * Final slip payout once ALL legs have resolved. Pass the realized odds
 * of each leg: the locked odds for a won leg, 1.0 for a void leg. A lost
 * leg means the slip is dead — do NOT call this; the slip pays 0.
 *
 * Capped at MULT_MAX_PAYOUT_TNGN. Returns the integer tNGN to credit.
 */
export function computeSlipPayout(netSlipStake: number, legRealizedOdds: number[]): number {
  if (legRealizedOdds.length === 0) return 0;
  const product = legRealizedOdds.reduce((acc, o) => acc * (Number.isFinite(o) && o > 0 ? o : 1), 1);
  const raw = netSlipStake * product;
  return Math.min(MULT_MAX_PAYOUT_TNGN, Math.round(raw));
}

/**
 * House P&L for a settled slip. Positive = house profit.
 *   - Slip won: house P&L = netSlipStake − payout (usually large loss
 *     on this one slip, funded by the many dead slips).
 *   - Slip lost: house P&L = +netSlipStake (we keep the whole stake).
 */
export function slipHousePnl(netSlipStake: number, won: boolean, payoutTngn: number): number {
  return won ? netSlipStake - payoutTngn : netSlipStake;
}
