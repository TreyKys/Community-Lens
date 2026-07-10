/**
 * lib/lockedOdds.ts
 *
 * THE canonical locked-odds algorithm. This is the single function consulted
 * by both the bet modal (to display the range) and the server (to freeze the
 * locked odds on the bet row at placement, and to settle the bet at
 * resolution). Display and settlement call the SAME pure function on the
 * SAME inputs so the user can never see one number and be paid another.
 *
 * Pure function. No I/O, no side effects, no React, no Supabase. Runs
 * identically in the browser, in a Next.js route handler, and (via the
 * settlement RPC's input args) in a Postgres function context.
 *
 * Read alongside docs/locked-odds-and-multipliers-spec.md.
 *
 * THE MENTAL MODEL
 * ────────────────
 *   1. The user's bet has an INVISIBLE 1.5% entry rake shaved off the gross
 *      stake before it enters any math: net_stake = stake * (1 - 0.015).
 *   2. The market has a HOUSE SEED that opens the line and dampens whale
 *      moves. effective_pool[i] = seed_pool[i] + real_pool[i].
 *   3. We compute the FAIR raw odds from the effective pools — INCLUDING
 *      this prospective stake on the chosen side, so big bets get worse
 *      odds (slippage protection against whales locking the pre-stake line).
 *   4. We apply a DYNAMIC VIG composed of:
 *        - Category base (see VIG_DEFAULTS)
 *        - Thin-pool surcharge (real stakes haven't dwarfed the seed yet)
 *        - Large-stake surcharge (this bet is a meaningful chunk of the
 *          opposing pool)
 *        - Reserve-stress surcharge (deployable capital is low)
 *        - Accuracy-privilege discount (top-accuracy users get cheaper odds)
 *      Clamped to [MIN_VIG, MAX_VIG].
 *   5. We apply a SERVER-ENFORCED FLOOR so the user is never quoted worse
 *      than a fair-for-Nigerian-betting minimum.
 *        - Stake < ₦500 → floor 1.03 (Tier 1)
 *        - Stake ≥ ₦500 → floor 1.02 (Tier 2)
 *      The floor is monotonic across the boundary by construction (see
 *      lib/displayMultiplier — the floor logic is shared, single source of
 *      truth).
 *   6. We cap with a SANITY CEILING so a thin market can't quote 50x.
 *   7. We round deterministically (HALF-UP to 2 dp) so display and
 *      settlement always produce identical numbers.
 *
 * THE FLOOR-UP PROMISE
 * ────────────────────
 * The locked_odds returned by this function is the GUARANTEED FLOOR. At
 * settlement we pay MAX(floor_payout, parimutuel-with-vig). If the pool
 * stays flat or moves against the user, the floor binds and they get their
 * promised minimum. If the pool moves with them (opposing money lands),
 * they get more. We NEVER pay less than the displayed floor — that is the
 * line we agreed not to cross. The "₦X – ₦Y if correct" display is honest:
 * X is the floor we guarantee, Y is a realistic projection of the upside.
 */

// ─── Public constants (referenced by tests, admin UI, settlement) ────────

/** Stake threshold separating the two tiers. Tier-2 mechanics apply at or above. */
export const TIER2_MIN_STAKE = 500;

/** Server-enforced floor multiplier for Tier 1 (sub-₦500 stakes). */
export const TIER1_FLOOR = 1.03;

/** Server-enforced floor multiplier for Tier 2 (≥₦500 stakes). */
export const TIER2_FLOOR = 1.02;

/** Invisible-to-user rake shaved off gross stake before any math. */
export const ENTRY_RAKE_PCT = 0.015;

/** Sanity ceiling. Even on a maximally thin market we never quote above this. */
export const MAX_ODDS = 25;

/** Floor on the dynamic vig. Below this, single bets stop being profitable. */
export const MIN_VIG = 0.04;

/** Ceiling on the dynamic vig. Above this, odds become embarrassing/uncompetitive. */
export const MAX_VIG = 0.15;

/**
 * Maximum multiplier between the floor payout and the upper end of the
 * displayed range. Keeps the "₦X – ₦Y" range from showing a wildly
 * optimistic Y on thin markets where projection math goes parabolic.
 */
export const RANGE_UPPER_CAP_RATIO = 2.5;

/**
 * Per-category vig defaults. Admin can override per market via
 * markets.vig_pct. Lower for high-visibility / price-checkable markets
 * (football fixtures, where users compare against Sportybet), higher for
 * markets where the crowd has weaker priors and we accept lower volume.
 *
 * Keys match the values that live in markets.category today plus a few
 * forward-looking categories. Add new ones here; the resolver falls back
 * to `default` rather than throwing.
 */
export const VIG_DEFAULTS = {
  sports:        0.07, // mid-tier fixtures, props
  sports_top:    0.06, // EPL / UCL / AFCON top fixtures — sharpest price-checking
  sports_props:  0.07, // over/under, BTTS — modelable with edge
  combat:        0.08, // UFC / boxing — crowd overbacks the star
  economy:       0.09, // FX, MPR, stocks
  economics:     0.09, // existing category alias
  finance:       0.09, // existing category alias
  crypto:        0.08, // BTC milestones etc.
  entertainment: 0.09, // BBNaija, awards
  politics:      0.10, // date-certain only, wider edge
  culture:       0.10, // pure crowd discovery, smaller seeds
  default:       0.08,
} as const;

// ─── Public types ────────────────────────────────────────────────────────

/**
 * Snapshot of the market at the moment of stake. Caller is responsible for
 * reading the current state from Postgres (atomic, row-locked, in the
 * place_bet RPC) and passing it in here.
 */
export interface MarketSnapshot {
  /** Free-form category from markets.category. Drives the vig default. */
  category: string;
  /** House seed by outcome index. Length matches market.options. */
  seedPool: number[];
  /** Crowd stakes (net of entry rake) by outcome index. Length matches market.options. */
  realPool: number[];
  /**
   * Per-market vig override from markets.vig_pct. If undefined, the
   * category default applies. Surcharges add on top regardless.
   */
  vigPctOverride?: number;
}

/**
 * Per-user context that influences pricing. Read from the users table.
 * Pass undefined fields explicitly for new users with no history.
 */
export interface UserContext {
  /**
   * Accuracy band. `pro` and `elite` get a -2% vig discount (floored at
   * MIN_VIG) as the headline privilege of the accuracy ladder.
   */
  accuracyTier?: 'rookie' | 'rising' | 'sharp' | 'top' | 'elite' | 'pro';
}

/**
 * House reserve snapshot. Read from the reserve_health view, passed in
 * verbatim so the function stays pure.
 */
export interface ReserveContext {
  /** total_tngn - floor_tngn from reserve_health view. */
  deployableTngn: number;
  /** floor_tngn from reserve_health view. The untouchable safety buffer. */
  floorTngn: number;
}

/**
 * Everything settlement and the modal need to know. Returned together so
 * the caller doesn't have to recompute any of it.
 */
export interface LockedOddsResult {
  /**
   * The frozen multiplier we store on the bet row. Guaranteed minimum.
   * Floor of the displayed range. ALWAYS honoured at settlement.
   */
  lockedOdds: number;
  /** net_stake (stake after the invisible 1.5% entry rake). */
  netStake: number;
  /** The number we guarantee in tNGN at settlement. ROUND TO NEAREST. */
  floorPayout: number;
  /**
   * Realistic upside payout shown as the top of the "₦X – ₦Y if correct"
   * range. Computed by projecting how the pool might fill in the
   * user's favour and recomputing odds with the SAME vig. Always >= floor.
   * Capped at floorPayout * RANGE_UPPER_CAP_RATIO so thin markets don't
   * show parabolic ranges.
   */
  upperPayout: number;
  /** The dynamic vig that was applied. Stored on the bet row for settlement. */
  vigApplied: number;
  /** 1 = Tier 1 (stake < 500), 2 = Tier 2 (stake >= 500). */
  tier: 1 | 2;
  /** Internal-only flags useful for debugging / admin preview. */
  diagnostics: {
    floorBound: boolean;            // floor saved us from quoting worse odds
    ceilingBound: boolean;          // sanity ceiling clipped us
    rawFairOdds: number;            // odds before vig applied
    surcharges: VigSurcharges;
  };
}

export interface VigSurcharges {
  category: number;
  thinPool: number;
  largeStake: number;
  reserveStress: number;
  accuracyDiscount: number;
  /** The number actually applied after clamp to [MIN_VIG, MAX_VIG]. */
  finalVig: number;
}

// ─── The canonical function ──────────────────────────────────────────────

/**
 * Compute everything needed to quote and freeze a locked-odds bet.
 *
 * Pure, deterministic, and stable across browser and server runtimes.
 *
 * Throws on programmer errors (invalid stake, invalid outcome index). DOES
 * NOT throw on degenerate market state (empty seed, etc.) — those return
 * a defensive defaults rather than crashing the bet flow.
 */
export function calculateLockedOdds(
  market: MarketSnapshot,
  stake: number,
  outcomeIndex: number,
  user: UserContext,
  reserve: ReserveContext,
): LockedOddsResult {
  // 0. Programmer-error guards. These are bugs, not user states.
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error(`lockedOdds: stake must be a positive finite number, got ${stake}`);
  }
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0) {
    throw new Error(`lockedOdds: outcomeIndex must be a non-negative integer, got ${outcomeIndex}`);
  }
  const numOutcomes = market.seedPool.length;
  if (numOutcomes < 2) {
    throw new Error(`lockedOdds: market must have at least 2 outcomes, got ${numOutcomes}`);
  }
  if (outcomeIndex >= numOutcomes) {
    throw new Error(`lockedOdds: outcomeIndex ${outcomeIndex} out of range for ${numOutcomes} outcomes`);
  }
  if (market.realPool.length !== numOutcomes) {
    throw new Error(
      `lockedOdds: realPool length ${market.realPool.length} does not match seedPool length ${numOutcomes}`,
    );
  }

  // 1. Tier from stake size. For multiplier legs the caller passes the
  //    SLIP stake here, not the per-leg notional.
  const tier: 1 | 2 = stake < TIER2_MIN_STAKE ? 1 : 2;
  // The "naïve" floor for the tier — what we'd use if we weren't worried
  // about boundary monotonicity. See the boundary adjustment below.
  const naiveTierFloor = tier === 1 ? TIER1_FLOOR : TIER2_FLOOR;

  // 2. Invisible entry rake. Done first so all downstream math uses the
  //    user's effective stake. The user never sees the shave; the gross
  //    stake is what enters the pool from their perspective, but for the
  //    odds calculation we operate on the net so margins compose correctly.
  const netStake = stake * (1 - ENTRY_RAKE_PCT);

  // 2a. Boundary-monotonic floor multiplier. Without this, a stake of
  //     ₦499 (Tier 1, floor 1.03) can produce a HIGHER floor payout than
  //     ₦500 (Tier 2, floor 1.02) on a lopsided market, so a user betting
  //     more visibly gets paid less if correct — exactly the bait-and-
  //     switch the display-floor was built to prevent. We pin the Tier 2
  //     floor multiplier so its payout at any stake is at least the
  //     Tier 1 floor payout AT THE BOUNDARY. For stakes well above ₦500
  //     the boundary correction collapses to TIER2_FLOOR and nothing
  //     changes; only the immediate post-boundary region is lifted.
  //     Mirrors lib/displayMultiplier.displayFloorPayout — single source
  //     of truth for the monotonicity invariant.
  const tierFloor = tier === 2
    ? Math.max(
        TIER2_FLOOR,
        (TIER2_MIN_STAKE * (1 - ENTRY_RAKE_PCT) * TIER1_FLOOR) / netStake,
      )
    : naiveTierFloor;

  // 3. Effective pools. Defensive cleanup turns any negative / NaN entries
  //    into 0 — better than crashing if a transient DB read is wrong.
  const effective = market.seedPool.map((s, i) => {
    const safeSeed = Number.isFinite(s) && s > 0 ? s : 0;
    const real = market.realPool[i];
    const safeReal = Number.isFinite(real) && real > 0 ? real : 0;
    return safeSeed + safeReal;
  });

  // 4. Slippage-safe pricing — include the prospective stake on the chosen
  //    side BEFORE computing odds. The bigger the bet, the more it moves
  //    its own line, so the bigger bet gets worse odds. Stops whales from
  //    sliding under the pre-stake price.
  const effectiveWithStake = [...effective];
  effectiveWithStake[outcomeIndex] += netStake;

  const total = effectiveWithStake.reduce((a, b) => a + b, 0);
  const poolChosen = effectiveWithStake[outcomeIndex];

  // 5. Compute dynamic vig BEFORE the degenerate-state guard. The vig
  //    is informative for the defensive default's diagnostics.
  const surcharges = computeVigSurcharges(market, stake, outcomeIndex, user, reserve);

  // 6. Degenerate state guard: if total or poolChosen are non-positive
  //    after all the cleanup above, the math would blow up. Return a
  //    defensive default at the sanity ceiling — the user gets max odds
  //    on a market with no liquidity, the floor still applies.
  if (total <= 0 || poolChosen <= 0) {
    return defensiveDefault(stake, netStake, tier, tierFloor, surcharges);
  }

  // 7. Raw fair odds before any vig. This is the parimutuel-style
  //    implied multiplier from the current effective pool composition.
  const rawFairOdds = total / poolChosen;

  // 8. Apply the dynamic vig. odds = raw / (1 + vig) — standard overround
  //    arithmetic so implied probabilities sum to (1 + vig) > 100%.
  let odds = rawFairOdds / (1 + surcharges.finalVig);

  // 9. Server-enforced floor. The promise to the user that the displayed
  //    minimum is real.
  const floorBound = odds < tierFloor;
  if (floorBound) odds = tierFloor;

  // 10. Sanity ceiling. Thin markets can produce raw multiples that
  //     embarrass us (and produce silly displayed payouts). Cap.
  const ceilingBound = odds > MAX_ODDS;
  if (ceilingBound) odds = MAX_ODDS;

  // 11. Deterministic rounding so display and settlement always agree.
  const lockedOdds = roundHalfUp(odds, 2);

  // 12. Floor payout — the guaranteed minimum, what we store as the
  //     bottom of the displayed range and honour at settlement.
  const floorPayout = Math.round(netStake * lockedOdds);

  // 13. Upper end of the displayed range — a projection of "what could
  //     this become if the opposing side fills?". We assume the opposing
  //     pool doubles from its current real-stake level (not seed —
  //     seed is fixed by the house), recompute odds with the SAME vig,
  //     and pay out at that rate. Capped at floorPayout * 2.5 so thin
  //     markets don't show wild ranges.
  const upperPayout = computeUpperPayout({
    netStake,
    floorPayout,
    seedPool: market.seedPool,
    realPool: market.realPool,
    outcomeIndex,
    finalVig: surcharges.finalVig,
  });

  return {
    lockedOdds,
    netStake,
    floorPayout,
    upperPayout,
    vigApplied: surcharges.finalVig,
    tier,
    diagnostics: {
      floorBound,
      ceilingBound,
      rawFairOdds,
      surcharges,
    },
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Dynamic vig composition. Exported via diagnostics so admin tools can
 * show "why is this market quoting 9% instead of 7%?" answers.
 */
function computeVigSurcharges(
  market: MarketSnapshot,
  stake: number,
  outcomeIndex: number,
  user: UserContext,
  reserve: ReserveContext,
): VigSurcharges {
  // Base from per-market override or per-category default.
  const category = (
    market.vigPctOverride !== undefined && Number.isFinite(market.vigPctOverride)
      ? Math.max(MIN_VIG, Math.min(MAX_VIG, market.vigPctOverride))
      : resolveCategoryVig(market.category)
  );

  // Thin-pool surcharge. When real stakes haven't dwarfed the seed,
  // the line is mostly the house's prior — wider vig protects us from
  // weak crowd-priced markets. As volume builds the surcharge falls
  // to zero on its own.
  const totalSeed = market.seedPool.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  const totalReal = market.realPool.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  let thinPool = 0;
  if (totalSeed > 0) {
    const ratio = totalReal / totalSeed;
    if (ratio < 1) thinPool = 0.02;
    else if (ratio < 2) thinPool = 0.01;
  } else if (totalReal > 0) {
    // No seed but some real stakes — unusual, treat as thin-ish.
    thinPool = 0.01;
  } else {
    // Fully empty market. Maximum thin-pool surcharge.
    thinPool = 0.02;
  }

  // Large-stake surcharge. If this stake is a meaningful fraction of
  // the OPPOSING pool, it concentrates our liability. Extra vig on
  // top of slippage — ramped smoothly from 0 at 50% of the opposing
  // effective pool up to the full 0.01 by 100%, rather than a hard
  // step at the 50% threshold.
  //
  // A hard step here was a real bug: total guaranteed payout could
  // FALL as stake rose past the threshold (e.g. staking ₦501 instead
  // of ₦500 paid strictly less, because the instantaneous +1% vig
  // outweighed the extra ₦1 of stake). That's never correct for any
  // pricing engine — a bigger stake must never buy less. The ramp
  // keeps the same "starts mattering at 50%" threshold but makes the
  // surcharge, and therefore payout, continuous in stake.
  const opposingEffective = market.seedPool.reduce((acc, s, i) => {
    if (i === outcomeIndex) return acc;
    const safeSeed = Number.isFinite(s) && s > 0 ? s : 0;
    const real = market.realPool[i];
    const safeReal = Number.isFinite(real) && real > 0 ? real : 0;
    return acc + safeSeed + safeReal;
  }, 0);
  const stakeRatio = opposingEffective > 0 ? stake / opposingEffective : 0;
  const largeStake = 0.01 * Math.max(0, Math.min(1, (stakeRatio - 0.5) / 0.5));

  // Reserve-stress surcharge. The house protects itself before the
  // stake cap needs to tighten. Threshold: deployable < 60% of floor.
  // (floor=30k, so threshold deployable = 18k. With initial state of
  // deployable=120k, this never triggers until we've burnt 102k.)
  const reserveStress = reserve.floorTngn > 0
    && reserve.deployableTngn < reserve.floorTngn * 0.6
    ? 0.02
    : 0;

  // Accuracy-privilege discount. The headline benefit of the accuracy
  // ladder: top users get cheaper odds. Floored at MIN_VIG so the
  // discount can't push the vig into unprofitable territory.
  const accuracyDiscount = (user.accuracyTier === 'pro' || user.accuracyTier === 'elite')
    ? 0.02
    : 0;

  const preClamp = category + thinPool + largeStake + reserveStress - accuracyDiscount;
  const finalVig = Math.max(MIN_VIG, Math.min(MAX_VIG, preClamp));

  return {
    category,
    thinPool,
    largeStake,
    reserveStress,
    accuracyDiscount,
    finalVig,
  };
}

/**
 * Look up the category default vig. Falls back to `default` rather than
 * throwing so a new category that hasn't been added to VIG_DEFAULTS yet
 * still produces a quotable price.
 */
function resolveCategoryVig(category: string): number {
  const key = category as keyof typeof VIG_DEFAULTS;
  if (Object.prototype.hasOwnProperty.call(VIG_DEFAULTS, key)) {
    return VIG_DEFAULTS[key];
  }
  return VIG_DEFAULTS.default;
}

/**
 * Project a realistic upper payout for the displayed range. Approach:
 * double the OPPOSING real-stake pool (seed is fixed; pool fills from
 * crowd flow), recompute odds with the same vig, take the projected
 * payout. Cap at floorPayout * RANGE_UPPER_CAP_RATIO so thin markets
 * don't blow up.
 */
function computeUpperPayout(args: {
  netStake: number;
  floorPayout: number;
  seedPool: number[];
  realPool: number[];
  outcomeIndex: number;
  finalVig: number;
}): number {
  const { netStake, floorPayout, seedPool, realPool, outcomeIndex, finalVig } = args;

  // Projected effective pools: chosen side unchanged from stake time;
  // opposing real-stake side doubles. Floor of 1 unit on doubled side
  // ensures we don't divide by zero on a market with no opposing real
  // stakes yet (the seed is still in the chosen denominator).
  const projected = seedPool.map((s, i) => {
    const safeSeed = Number.isFinite(s) && s > 0 ? s : 0;
    const realRaw = realPool[i];
    const safeReal = Number.isFinite(realRaw) && realRaw > 0 ? realRaw : 0;
    if (i === outcomeIndex) {
      return safeSeed + safeReal + netStake;
    }
    // Opposing real doubles; minimum 1 tNGN to avoid zero pools.
    const projectedReal = Math.max(1, safeReal * 2);
    return safeSeed + projectedReal;
  });

  const projectedTotal = projected.reduce((a, b) => a + b, 0);
  const projectedChosen = projected[outcomeIndex];

  if (projectedChosen <= 0 || projectedTotal <= 0) {
    return floorPayout;
  }

  const projectedRaw = projectedTotal / projectedChosen;
  const projectedOdds = Math.min(MAX_ODDS, projectedRaw / (1 + finalVig));
  const projectedPayout = Math.round(netStake * projectedOdds);

  // Pay-MAX-of-floor-or-projection invariant + sanity cap on the range
  // width so we don't ever show 1.05x – 25x.
  const capped = Math.min(projectedPayout, Math.round(floorPayout * RANGE_UPPER_CAP_RATIO));
  return Math.max(floorPayout, capped);
}

/**
 * Defensive degenerate-state default. Should never be reached in
 * practice (seed is always present on a locked-odds market), but if it
 * is, we return MAX_ODDS at the relevant tier floor and let the floor
 * payout speak. Crashing here would kill the bet flow.
 */
function defensiveDefault(
  stake: number,
  netStake: number,
  tier: 1 | 2,
  tierFloor: number,
  surcharges: VigSurcharges,
): LockedOddsResult {
  const odds = Math.max(tierFloor, MAX_ODDS);
  const payout = Math.round(netStake * odds);
  return {
    lockedOdds: odds,
    netStake,
    floorPayout: payout,
    upperPayout: payout,
    vigApplied: surcharges.finalVig,
    tier,
    diagnostics: {
      floorBound: false,
      ceilingBound: true,
      rawFairOdds: Number.POSITIVE_INFINITY,
      surcharges,
    },
  };
}

/**
 * Deterministic HALF-UP rounding for the locked odds. JavaScript's
 * Math.round is HALF-AWAY-FROM-ZERO which behaves like HALF-UP for
 * positive numbers — but we go through this helper anyway so the
 * intent is explicit and future refactors (e.g. negative numbers)
 * don't break the invariant that display === settlement.
 */
function roundHalfUp(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
