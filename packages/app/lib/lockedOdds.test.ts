import { describe, it, expect } from 'vitest';
import {
  calculateLockedOdds,
  TIER1_FLOOR,
  TIER2_FLOOR,
  TIER2_MIN_STAKE,
  ENTRY_RAKE_PCT,
  MAX_ODDS,
  MIN_VIG,
  MAX_VIG,
  RANGE_UPPER_CAP_RATIO,
  VIG_DEFAULTS,
  type MarketSnapshot,
  type UserContext,
  type ReserveContext,
} from './lockedOdds';

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

/** Healthy reserve — well above floor, no stress surcharge. */
const HEALTHY: ReserveContext = { deployableTngn: 120_000, floorTngn: 30_000 };
/** Stressed reserve — deployable < 0.6 × floor triggers +2% vig. */
const STRESSED: ReserveContext = { deployableTngn: 10_000, floorTngn: 30_000 };

const NEW_USER: UserContext = {};
const PRO_USER: UserContext = { accuracyTier: 'pro' };

/**
 * Balanced 2-outcome market with healthy crowd flow on both sides. Used
 * as the "ordinary day" baseline for most tests.
 */
function balancedMarket(): MarketSnapshot {
  return {
    category: 'sports',
    seedPool: [6_000, 6_000],
    realPool: [20_000, 20_000],
  };
}

/**
 * Lopsided market with the chosen outcome heavily backed. Forces the
 * Tier 1 floor to bind (raw odds would be sub-1.0x without the floor).
 */
function lopsidedMarket(): MarketSnapshot {
  return {
    category: 'sports',
    seedPool: [6_000, 6_000],
    realPool: [80_000, 2_000],
  };
}

/**
 * Extremely lopsided market — needed to force Tier 2's 1.02 floor to
 * bind (a much lower floor than Tier 1's 1.03, so much harder to trip).
 */
function extremelyLopsidedMarket(): MarketSnapshot {
  return {
    category: 'sports',
    seedPool: [3_000, 3_000],
    realPool: [200_000, 1_000],
  };
}

/** Thin market: real stakes << seed. Triggers thin-pool surcharge. */
function thinMarket(): MarketSnapshot {
  return {
    category: 'sports',
    seedPool: [6_000, 6_000],
    realPool: [500, 500],
  };
}

/** Empty market: no real crowd flow yet. Maximum thin-pool surcharge. */
function emptyMarket(): MarketSnapshot {
  return {
    category: 'sports',
    seedPool: [6_000, 6_000],
    realPool: [0, 0],
  };
}

/** 3-outcome market (football: Home / Draw / Away). */
function threeWayMarket(): MarketSnapshot {
  return {
    category: 'sports',
    seedPool: [5_000, 3_000, 4_000],
    realPool: [15_000, 8_000, 10_000],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Programmer-error guards
// ─────────────────────────────────────────────────────────────────────────

describe('input validation', () => {
  it('throws on a non-positive stake', () => {
    expect(() => calculateLockedOdds(balancedMarket(), 0, 0, NEW_USER, HEALTHY)).toThrow();
    expect(() => calculateLockedOdds(balancedMarket(), -100, 0, NEW_USER, HEALTHY)).toThrow();
  });

  it('throws on a non-finite stake', () => {
    expect(() => calculateLockedOdds(balancedMarket(), NaN, 0, NEW_USER, HEALTHY)).toThrow();
    expect(() => calculateLockedOdds(balancedMarket(), Infinity, 0, NEW_USER, HEALTHY)).toThrow();
  });

  it('throws on an out-of-range outcome index', () => {
    expect(() => calculateLockedOdds(balancedMarket(), 200, -1, NEW_USER, HEALTHY)).toThrow();
    expect(() => calculateLockedOdds(balancedMarket(), 200, 5, NEW_USER, HEALTHY)).toThrow();
  });

  it('throws on a market with fewer than 2 outcomes', () => {
    const broken: MarketSnapshot = { category: 'sports', seedPool: [1000], realPool: [500] };
    expect(() => calculateLockedOdds(broken, 200, 0, NEW_USER, HEALTHY)).toThrow();
  });

  it('throws when seedPool and realPool lengths disagree', () => {
    const broken: MarketSnapshot = { category: 'sports', seedPool: [1000, 1000], realPool: [500] };
    expect(() => calculateLockedOdds(broken, 200, 0, NEW_USER, HEALTHY)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tier routing
// ─────────────────────────────────────────────────────────────────────────

describe('tier resolution', () => {
  it('classifies sub-₦500 stakes as Tier 1', () => {
    const r = calculateLockedOdds(balancedMarket(), 100, 0, NEW_USER, HEALTHY);
    expect(r.tier).toBe(1);
  });

  it('classifies ₦499 as Tier 1', () => {
    const r = calculateLockedOdds(balancedMarket(), 499, 0, NEW_USER, HEALTHY);
    expect(r.tier).toBe(1);
  });

  it('classifies ₦500 exactly as Tier 2', () => {
    const r = calculateLockedOdds(balancedMarket(), TIER2_MIN_STAKE, 0, NEW_USER, HEALTHY);
    expect(r.tier).toBe(2);
  });

  it('classifies ₦5,000 as Tier 2', () => {
    const r = calculateLockedOdds(balancedMarket(), 5000, 0, NEW_USER, HEALTHY);
    expect(r.tier).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The server-enforced floor
// ─────────────────────────────────────────────────────────────────────────

describe('server-enforced floor', () => {
  it('honours the Tier 1 floor (1.03) on a lopsided market that would otherwise quote sub-1.0x', () => {
    const r = calculateLockedOdds(lopsidedMarket(), 200, 0, NEW_USER, HEALTHY);
    expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER1_FLOOR);
    expect(r.diagnostics.floorBound).toBe(true);
  });

  it('honours the Tier 2 floor (1.02) on an extremely lopsided market', () => {
    // Tier 2 floor (1.02) is much lower than Tier 1's (1.03), so it only
    // binds in genuinely extreme cases — hence the steeper fixture.
    const r = calculateLockedOdds(extremelyLopsidedMarket(), 1000, 0, NEW_USER, HEALTHY);
    expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER2_FLOOR);
    expect(r.diagnostics.floorBound).toBe(true);
  });

  it('does NOT artificially floor when honest odds beat the floor', () => {
    // Staking on the underdog in a market where opposing pool is larger
    // → raw odds well above floor → floor should not bind.
    const r = calculateLockedOdds(balancedMarket(), 200, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.floorBound).toBe(false);
    expect(r.lockedOdds).toBeGreaterThan(TIER1_FLOOR);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Monotonicity across the ₦500 boundary
// ─────────────────────────────────────────────────────────────────────────

describe('monotonicity around the ₦500 boundary', () => {
  it('never decreases floor payout as the stake increases across ₦499 → ₦500 on a thin market', () => {
    const m = thinMarket();
    const r499 = calculateLockedOdds(m, 499, 1, NEW_USER, HEALTHY);
    const r500 = calculateLockedOdds(m, 500, 1, NEW_USER, HEALTHY);
    // The floor multiplier drops from 1.03 to 1.02 across the boundary,
    // but the stake grew, so floor payout (= netStake × floor) must
    // monotonically increase — if it ever decreases, that's the bug
    // that would visibly punish a user for staking more.
    expect(r500.floorPayout).toBeGreaterThanOrEqual(r499.floorPayout);
  });

  it('never decreases floor payout across the boundary on a lopsided market either', () => {
    const m = lopsidedMarket();
    const r499 = calculateLockedOdds(m, 499, 0, NEW_USER, HEALTHY);
    const r500 = calculateLockedOdds(m, 500, 0, NEW_USER, HEALTHY);
    expect(r500.floorPayout).toBeGreaterThanOrEqual(r499.floorPayout);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The sanity ceiling
// ─────────────────────────────────────────────────────────────────────────

describe('sanity ceiling', () => {
  it('clips locked odds at MAX_ODDS (25) on a freshly seeded empty market when staking on the underdog', () => {
    // Construct a market thin enough that raw odds would exceed 25.
    const m: MarketSnapshot = {
      category: 'culture',
      seedPool: [100, 100], // tiny seed
      realPool: [10_000, 0], // huge flow on side 0, nothing on side 1
    };
    const r = calculateLockedOdds(m, 100, 1, NEW_USER, HEALTHY);
    expect(r.lockedOdds).toBeLessThanOrEqual(MAX_ODDS);
    expect(r.diagnostics.ceilingBound).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Entry rake (invisible)
// ─────────────────────────────────────────────────────────────────────────

describe('entry rake', () => {
  it('shaves 1.5% off the gross stake to produce netStake', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 0, NEW_USER, HEALTHY);
    expect(r.netStake).toBeCloseTo(1000 * (1 - ENTRY_RAKE_PCT), 6);
  });

  it('netStake feeds the floor payout calculation', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 0, NEW_USER, HEALTHY);
    expect(r.floorPayout).toBe(Math.round(r.netStake * r.lockedOdds));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slippage protection
// ─────────────────────────────────────────────────────────────────────────

describe('slippage protection', () => {
  it('a much larger stake gets noticeably worse odds than a small stake on the same side', () => {
    const small = calculateLockedOdds(balancedMarket(), 200, 0, NEW_USER, HEALTHY);
    // Whale-sized stake on a balanced ₦40k crowd pool will visibly move
    // the line against itself.
    const whale = calculateLockedOdds(balancedMarket(), 30_000, 0, NEW_USER, HEALTHY);
    expect(whale.lockedOdds).toBeLessThan(small.lockedOdds);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Dynamic vig composition
// ─────────────────────────────────────────────────────────────────────────

describe('dynamic vig', () => {
  it('uses the category default when no per-market override is set', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.category).toBeCloseTo(VIG_DEFAULTS.sports, 6);
  });

  it('falls back to the default vig for an unknown category', () => {
    const m: MarketSnapshot = { category: 'astrology', seedPool: [6_000, 6_000], realPool: [10_000, 10_000] };
    const r = calculateLockedOdds(m, 1000, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.category).toBeCloseTo(VIG_DEFAULTS.default, 6);
  });

  it('per-market override beats the category default', () => {
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [6_000, 6_000],
      realPool: [10_000, 10_000],
      vigPctOverride: 0.10,
    };
    const r = calculateLockedOdds(m, 1000, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.category).toBeCloseTo(0.10, 6);
  });

  it('applies the thin-pool surcharge when real stakes are well below the seed', () => {
    const r = calculateLockedOdds(thinMarket(), 200, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.thinPool).toBe(0.02);
  });

  it('applies the maximum thin-pool surcharge on a fully empty market', () => {
    const r = calculateLockedOdds(emptyMarket(), 200, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.thinPool).toBe(0.02);
  });

  it('drops the thin-pool surcharge to zero once real stakes dwarf the seed', () => {
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [6_000, 6_000],
      realPool: [40_000, 40_000], // 3.3x seed total — well above the 2x threshold
    };
    const r = calculateLockedOdds(m, 200, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.thinPool).toBe(0);
  });

  it('applies the large-stake surcharge when the stake exceeds 50% of opposing effective pool', () => {
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [3_000, 3_000],
      realPool: [5_000, 1_000],
    };
    // Opposing effective (outcome 1) = 3000 + 5000 = 8000 → 50% = 4000
    // Stake 5000 on outcome 0 → above threshold.
    const r = calculateLockedOdds(m, 5_000, 0, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.largeStake).toBe(0.01);
  });

  it('does NOT apply the large-stake surcharge on a small stake', () => {
    const r = calculateLockedOdds(balancedMarket(), 200, 0, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.largeStake).toBe(0);
  });

  it('applies the reserve-stress surcharge when deployable < 60% of floor', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 1, NEW_USER, STRESSED);
    expect(r.diagnostics.surcharges.reserveStress).toBe(0.02);
  });

  it('does NOT apply reserve stress on a healthy reserve', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 1, NEW_USER, HEALTHY);
    expect(r.diagnostics.surcharges.reserveStress).toBe(0);
  });

  it('discounts the vig by 2% for pro accuracy users', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 1, PRO_USER, HEALTHY);
    expect(r.diagnostics.surcharges.accuracyDiscount).toBe(0.02);
  });

  it('clamps the final vig to MAX_VIG even when surcharges stack', () => {
    // Stack thin (+2%) + large stake (+1%) + reserve stress (+2%) on a
    // 10% category → would be 0.15 before clamp. Add culture's 10% base
    // and we're at 0.15 (the ceiling). Bumping further must clamp.
    const m: MarketSnapshot = {
      category: 'culture',           // 0.10 base
      seedPool: [6_000, 6_000],
      realPool: [0, 0],              // thin → +0.02
      vigPctOverride: 0.13,          // override → 0.13 base
    };
    const r = calculateLockedOdds(m, 5_000, 0, NEW_USER, STRESSED); // large-stake + stress
    expect(r.diagnostics.surcharges.finalVig).toBeLessThanOrEqual(MAX_VIG + 1e-9);
  });

  it('clamps the final vig to MIN_VIG even when the discount would push it lower', () => {
    // sports_top is 6%; a pro user shaves 2% → 4%. Right at MIN_VIG.
    // If we had a hypothetical 5% category and a 2% discount, MIN_VIG must
    // hold the line.
    const m: MarketSnapshot = {
      category: 'sports_top',
      seedPool: [6_000, 6_000],
      realPool: [40_000, 40_000], // fat → no thin surcharge
      vigPctOverride: 0.05,       // simulate a sharper override
    };
    const r = calculateLockedOdds(m, 1000, 1, PRO_USER, HEALTHY);
    expect(r.diagnostics.surcharges.finalVig).toBeGreaterThanOrEqual(MIN_VIG - 1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Floor payout & upper payout
// ─────────────────────────────────────────────────────────────────────────

describe('display range', () => {
  it('upper payout is always >= floor payout', () => {
    const r = calculateLockedOdds(balancedMarket(), 500, 0, NEW_USER, HEALTHY);
    expect(r.upperPayout).toBeGreaterThanOrEqual(r.floorPayout);
  });

  it('upper payout is capped at floor × RANGE_UPPER_CAP_RATIO', () => {
    const r = calculateLockedOdds(thinMarket(), 200, 0, NEW_USER, HEALTHY);
    expect(r.upperPayout).toBeLessThanOrEqual(Math.round(r.floorPayout * RANGE_UPPER_CAP_RATIO));
  });

  it('on a market with healthy opposing flow, upper exceeds floor (the user actually sees a range)', () => {
    // Stake on side 1 of a balanced market → opposing side has real
    // flow that can plausibly double. Projection should pull upper
    // higher than floor.
    const r = calculateLockedOdds(balancedMarket(), 500, 1, NEW_USER, HEALTHY);
    expect(r.upperPayout).toBeGreaterThan(r.floorPayout);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Determinism (display == settlement)
// ─────────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('returns identical lockedOdds and floorPayout for identical inputs', () => {
    const a = calculateLockedOdds(balancedMarket(), 750, 0, NEW_USER, HEALTHY);
    const b = calculateLockedOdds(balancedMarket(), 750, 0, NEW_USER, HEALTHY);
    expect(a.lockedOdds).toBe(b.lockedOdds);
    expect(a.floorPayout).toBe(b.floorPayout);
    expect(a.vigApplied).toBe(b.vigApplied);
  });

  it('locked odds is rounded to 2 decimals (display-settlement invariant)', () => {
    const r = calculateLockedOdds(balancedMarket(), 1000, 0, NEW_USER, HEALTHY);
    // Multiply by 100; result must be an integer.
    const x100 = Math.round(r.lockedOdds * 100);
    expect(Math.abs(r.lockedOdds * 100 - x100)).toBeLessThan(1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-outcome markets (>2 options)
// ─────────────────────────────────────────────────────────────────────────

describe('multi-outcome markets', () => {
  it('produces sane odds for every outcome of a 3-way market', () => {
    const m = threeWayMarket();
    for (let i = 0; i < 3; i++) {
      const r = calculateLockedOdds(m, 500, i, NEW_USER, HEALTHY);
      expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER2_FLOOR);
      expect(r.lockedOdds).toBeLessThanOrEqual(MAX_ODDS);
      expect(r.floorPayout).toBeGreaterThan(0);
    }
  });

  it('the smallest pool (the underdog) gets the longest odds', () => {
    const m = threeWayMarket();
    // Pools: [20000, 11000, 14000] effective. Smallest = outcome 1.
    const a = calculateLockedOdds(m, 500, 0, NEW_USER, HEALTHY);
    const b = calculateLockedOdds(m, 500, 1, NEW_USER, HEALTHY);
    const c = calculateLockedOdds(m, 500, 2, NEW_USER, HEALTHY);
    expect(b.lockedOdds).toBeGreaterThan(a.lockedOdds);
    expect(b.lockedOdds).toBeGreaterThan(c.lockedOdds);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Defensive degenerate state
// ─────────────────────────────────────────────────────────────────────────

describe('defensive degenerate-state handling', () => {
  it('does not crash on a zero-seed zero-real market — returns floor-clamped odds', () => {
    // Pure degenerate state is unreachable in practice because the
    // prospective stake is itself added to the chosen pool before
    // pricing (the slippage-safe step), so total/chosen are always
    // positive. Verify the function produces valid finite odds inside
    // the [floor, MAX_ODDS] range and does not blow up.
    const m: MarketSnapshot = { category: 'sports', seedPool: [0, 0], realPool: [0, 0] };
    const r = calculateLockedOdds(m, 200, 0, NEW_USER, HEALTHY);
    expect(Number.isFinite(r.lockedOdds)).toBe(true);
    expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER1_FLOOR);
    expect(r.lockedOdds).toBeLessThanOrEqual(MAX_ODDS);
    expect(r.floorPayout).toBeGreaterThan(0);
  });

  it('treats negative pool values as zero rather than producing nonsense odds', () => {
    const m: MarketSnapshot = { category: 'sports', seedPool: [-1000, 6_000], realPool: [-500, 10_000] };
    const r = calculateLockedOdds(m, 500, 1, NEW_USER, HEALTHY);
    expect(Number.isFinite(r.lockedOdds)).toBe(true);
    expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER2_FLOOR);
  });
});
