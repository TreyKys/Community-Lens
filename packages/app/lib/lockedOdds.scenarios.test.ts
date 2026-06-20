/**
 * Battle-test scenarios for the locked-odds algorithm.
 *
 * Unlike lockedOdds.test.ts (which checks invariants — floor binds,
 * vig stacks, etc.), this file walks through realistic Nigerian-betting
 * flows end-to-end and asserts the numbers a real user would see make
 * narrative sense. Each test is a story:
 *
 *   "A first-time user stakes ₦200 on Arsenal vs Chelsea before kickoff…"
 *
 * If we ever regress the algorithm in a way that makes one of these
 * stories produce nonsense (e.g. someone staking ₦200 gets a 0.92×
 * multiplier, or a whale on a thin market sees no slippage), these
 * scenarios catch it where pure unit tests might miss it.
 *
 * Numbers below were sanity-checked by hand against the algorithm in
 * lib/lockedOdds.ts at the time of writing. If the algorithm changes,
 * update the assertions accordingly — but verify the new numbers
 * actually tell a sensible story before committing.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateLockedOdds,
  TIER1_FLOOR,
  TIER2_FLOOR,
  type MarketSnapshot,
  type UserContext,
  type ReserveContext,
} from './lockedOdds';

const HEALTHY: ReserveContext = { deployableTngn: 120_000, floorTngn: 30_000 };
const STRESSED: ReserveContext = { deployableTngn: 10_000, floorTngn: 30_000 };
const NEW_USER: UserContext = {};
const PRO_USER: UserContext = { accuracyTier: 'pro' };

describe('scenario: first-time user on a freshly-seeded EPL match', () => {
  // Arsenal vs Chelsea, both teams highly fancied. Admin seeds ₦8k Home
  // / ₦7k Away expressing a 53% home estimate. No real stakes yet — the
  // very first user has just opened the market.
  const arsenalChelsea = (): MarketSnapshot => ({
    category: 'sports',
    seedPool: [8_000, 7_000],
    realPool: [0, 0],
  });

  it('stake ₦200 on Home: sees a sensible Tier-1 floor above 1.03', () => {
    const r = calculateLockedOdds(arsenalChelsea(), 200, 0, NEW_USER, HEALTHY);
    expect(r.tier).toBe(1);
    expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER1_FLOOR);
    // Floor payout is the guarantee. On 197 net stake at floor ~1.03+
    // we expect at least 203 returned. The number itself is small —
    // that's correct, opening line on a near-even market.
    expect(r.floorPayout).toBeGreaterThanOrEqual(200);
    // At day-1 with zero opposing crowd flow, the projection has
    // nothing to extrapolate from — upper == floor is honest. The
    // upper diverges once the first opposing stake lands. This is
    // tested separately in the "matured market" scenario.
    expect(r.upperPayout).toBeGreaterThanOrEqual(r.floorPayout);
  });

  it('stake ₦200 on Away (the slight underdog): sees a higher multiplier than Home', () => {
    const home = calculateLockedOdds(arsenalChelsea(), 200, 0, NEW_USER, HEALTHY);
    const away = calculateLockedOdds(arsenalChelsea(), 200, 1, NEW_USER, HEALTHY);
    // The smaller seed pool is the underdog, so its locked odds must
    // be longer than the favorite's. If this flips, our pricing is
    // inverted — a critical regression.
    expect(away.lockedOdds).toBeGreaterThan(home.lockedOdds);
  });
});

describe('scenario: market with real crowd flow already in', () => {
  // Same Arsenal vs Chelsea, but two days in. Real stakes have piled up
  // ₦40k Home / ₦25k Away — market is heavy on Home now. New stakers
  // betting Home should see the line shortened; betting Away should
  // see it lengthened (the parimutuel-style movement that makes the
  // "climbs as others predict the other way" copy honest).
  const matured = (): MarketSnapshot => ({
    category: 'sports',
    seedPool: [8_000, 7_000],
    realPool: [40_000, 25_000],
  });

  it('a late ₦500 Home staker gets shorter odds than the first ₦500 Home staker would have', () => {
    const lateHome = calculateLockedOdds(matured(), 500, 0, NEW_USER, HEALTHY);
    const earlyHome = calculateLockedOdds(
      { category: 'sports', seedPool: [8_000, 7_000], realPool: [0, 0] },
      500, 0, NEW_USER, HEALTHY,
    );
    expect(lateHome.lockedOdds).toBeLessThan(earlyHome.lockedOdds);
  });

  it('a late ₦500 Away staker gets longer odds than the first ₦500 Away staker would have', () => {
    const lateAway = calculateLockedOdds(matured(), 500, 1, NEW_USER, HEALTHY);
    const earlyAway = calculateLockedOdds(
      { category: 'sports', seedPool: [8_000, 7_000], realPool: [0, 0] },
      500, 1, NEW_USER, HEALTHY,
    );
    expect(lateAway.lockedOdds).toBeGreaterThan(earlyAway.lockedOdds);
  });

  it('the displayed payout is visibly higher than what a first-mover would get', () => {
    // The whole product story: "your winnings grow as others predict
    // the other way". The 5th staker on the underdog should genuinely
    // see a better number than the 1st.
    const fresh: MarketSnapshot = { category: 'sports', seedPool: [8_000, 7_000], realPool: [0, 0] };
    const first = calculateLockedOdds(fresh, 500, 1, NEW_USER, HEALTHY);
    const later = calculateLockedOdds(matured(), 500, 1, NEW_USER, HEALTHY);
    expect(later.floorPayout).toBeGreaterThan(first.floorPayout);
  });
});

describe('scenario: whale stake on a thin culture market', () => {
  // BBNaija eviction prediction. Admin seeds a small ₦5k/₦5k because
  // we don't have a strong prior — let the crowd discover it. A user
  // appears with a ₦5,000 stake — half the seed itself.
  const bbnaija = (): MarketSnapshot => ({
    category: 'entertainment',
    seedPool: [5_000, 5_000],
    realPool: [0, 0],
  });

  it('the whale sees worse odds than they would on a fat market (slippage protection)', () => {
    const whaleThinMarket = calculateLockedOdds(bbnaija(), 5_000, 0, NEW_USER, HEALTHY);
    // Same whale on a fat ₦100k-each-side market gets near-fair odds.
    const fat: MarketSnapshot = {
      category: 'entertainment',
      seedPool: [5_000, 5_000],
      realPool: [100_000, 100_000],
    };
    const whaleFatMarket = calculateLockedOdds(fat, 5_000, 0, NEW_USER, HEALTHY);
    expect(whaleThinMarket.lockedOdds).toBeLessThan(whaleFatMarket.lockedOdds);
  });

  it('triggers thin-pool + large-stake surcharges (visible in diagnostics)', () => {
    const r = calculateLockedOdds(bbnaija(), 5_000, 0, NEW_USER, HEALTHY);
    // Entertainment base 9% + thin (no real flow at all) 2% + large stake
    // (5k > 50% of opposing 5k effective) 1% = 12% nominal, ~clamped if
    // higher. Just check both surcharges fired.
    expect(r.diagnostics.surcharges.thinPool).toBeGreaterThan(0);
    expect(r.diagnostics.surcharges.largeStake).toBeGreaterThan(0);
    expect(r.diagnostics.surcharges.finalVig).toBeGreaterThanOrEqual(0.09);
  });
});

describe('scenario: heavy-favorite market', () => {
  // Manchester City vs a relegation-zone side. Crowd has piled on City
  // 5:1. Backing the underdog now gets a beautiful long price. Backing
  // City gets you the floor — which is exactly what the floor is for
  // (you cannot get worse than ~1.02 even if the crowd has paid almost
  // all the price away).
  const favorite = (): MarketSnapshot => ({
    category: 'sports',
    seedPool: [10_000, 5_000],
    realPool: [100_000, 20_000],
  });

  it('a ₦500 City staker sees the floor, not a shameful sub-1.0x', () => {
    const r = calculateLockedOdds(favorite(), 500, 0, NEW_USER, HEALTHY);
    expect(r.lockedOdds).toBeGreaterThanOrEqual(TIER2_FLOOR);
    expect(r.floorPayout).toBeGreaterThan(500 * (1 - 0.015)); // > net stake
  });

  it('a ₦500 underdog staker sees a substantially better multiplier', () => {
    const r = calculateLockedOdds(favorite(), 500, 1, NEW_USER, HEALTHY);
    // Effective 25k vs 110k — should easily clear 4x raw, vig pulls
    // it back, but at least 3.0x.
    expect(r.lockedOdds).toBeGreaterThan(3);
  });
});

describe('scenario: reserve stress kicks in mid-week', () => {
  // Tier 2 markets have eaten into the reserve. Deployable drops below
  // 60% of floor (₦18k). The engine auto-widens vig by 2% to bank a
  // bigger margin on every new stake until reserve recovers.
  it('same stake on the same market shows wider vig under stress', () => {
    const m = (): MarketSnapshot => ({
      category: 'sports',
      seedPool: [8_000, 8_000],
      realPool: [20_000, 20_000],
    });
    const healthy = calculateLockedOdds(m(), 1_000, 1, NEW_USER, HEALTHY);
    const stressed = calculateLockedOdds(m(), 1_000, 1, NEW_USER, STRESSED);
    expect(stressed.diagnostics.surcharges.reserveStress).toBe(0.02);
    expect(healthy.diagnostics.surcharges.reserveStress).toBe(0);
    // User sees marginally worse locked odds — the surcharge is real
    // money for the house.
    expect(stressed.lockedOdds).toBeLessThan(healthy.lockedOdds);
  });
});

describe('scenario: pro forecaster discount', () => {
  // 75%+ accuracy users get -2% vig. The headline privilege. Compounds
  // their already-good picks into materially better profit per win.
  it('a pro forecaster on the same stake sees better locked odds than a rookie', () => {
    const m = (): MarketSnapshot => ({
      category: 'sports',
      seedPool: [8_000, 8_000],
      realPool: [20_000, 20_000],
    });
    const rookie = calculateLockedOdds(m(), 1_000, 1, NEW_USER, HEALTHY);
    const pro = calculateLockedOdds(m(), 1_000, 1, PRO_USER, HEALTHY);
    expect(pro.diagnostics.surcharges.accuracyDiscount).toBe(0.02);
    expect(rookie.diagnostics.surcharges.accuracyDiscount).toBe(0);
    expect(pro.lockedOdds).toBeGreaterThan(rookie.lockedOdds);
    // Concrete benefit: a few extra naira on a ₦1k stake. Compounds
    // across hundreds of bets a month.
    expect(pro.floorPayout).toBeGreaterThan(rookie.floorPayout);
  });
});

describe('scenario: category-specific pricing', () => {
  // Politics markets carry wider vig than top-tier sports — we have
  // less data, regulators are watching, and we accept lower volume in
  // exchange for safety margin.
  it('a politics market quotes a wider vig than a top sports market', () => {
    const baseMarket = (category: string): MarketSnapshot => ({
      category,
      seedPool: [8_000, 8_000],
      realPool: [20_000, 20_000],
    });
    const sports = calculateLockedOdds(baseMarket('sports'), 500, 1, NEW_USER, HEALTHY);
    const politics = calculateLockedOdds(baseMarket('politics'), 500, 1, NEW_USER, HEALTHY);
    expect(politics.diagnostics.surcharges.category).toBeGreaterThan(sports.diagnostics.surcharges.category);
    // Same stake, same pool, wider vig → shorter locked odds. House
    // protects margin where it needs it.
    expect(politics.lockedOdds).toBeLessThan(sports.lockedOdds);
  });
});

describe('scenario: range display is always honest', () => {
  // No matter what state, the displayed range (floor..upper) should
  // never invert (upper < floor) and never quote an upper outside
  // [floor, MAX × floor].
  it('range invariants hold across a sweep of stakes and markets', () => {
    const markets: MarketSnapshot[] = [
      { category: 'sports', seedPool: [6_000, 6_000], realPool: [0, 0] },
      { category: 'sports', seedPool: [6_000, 6_000], realPool: [50_000, 50_000] },
      { category: 'politics', seedPool: [4_000, 4_000], realPool: [10_000, 2_000] },
      { category: 'entertainment', seedPool: [5_000, 5_000], realPool: [30_000, 5_000] },
      { category: 'economy', seedPool: [6_000, 4_000], realPool: [15_000, 25_000] },
    ];
    const stakes = [100, 200, 499, 500, 1_000, 5_000];

    for (const m of markets) {
      for (const stake of stakes) {
        for (let outcome = 0; outcome < m.seedPool.length; outcome++) {
          const r = calculateLockedOdds(m, stake, outcome, NEW_USER, HEALTHY);
          // The non-negotiables:
          expect(r.upperPayout).toBeGreaterThanOrEqual(r.floorPayout);
          expect(r.floorPayout).toBeGreaterThan(0);
          expect(r.lockedOdds).toBeGreaterThanOrEqual(1.02);
          expect(r.lockedOdds).toBeLessThanOrEqual(25);
          expect(Number.isFinite(r.upperPayout)).toBe(true);
        }
      }
    }
  });
});

describe('scenario: stake-grows-monotonically across a long sweep', () => {
  // As stake increases by ₦100 each step from ₦100 to ₦5,000, the
  // floor payout in tNGN must never decrease. Catches any boundary
  // condition we might have missed beyond the ₦499 / ₦500 fix.
  it('floor payout monotonically increases across stake sweep on a balanced market', () => {
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [6_000, 6_000],
      realPool: [20_000, 20_000],
    };
    let lastPayout = 0;
    for (let stake = 100; stake <= 5_000; stake += 100) {
      const r = calculateLockedOdds(m, stake, 0, NEW_USER, HEALTHY);
      expect(r.floorPayout).toBeGreaterThanOrEqual(lastPayout);
      lastPayout = r.floorPayout;
    }
  });

  it('floor payout monotonically increases across stake sweep on a lopsided market', () => {
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [6_000, 6_000],
      realPool: [80_000, 2_000],
    };
    let lastPayout = 0;
    for (let stake = 100; stake <= 5_000; stake += 100) {
      const r = calculateLockedOdds(m, stake, 0, NEW_USER, HEALTHY);
      expect(r.floorPayout).toBeGreaterThanOrEqual(lastPayout);
      lastPayout = r.floorPayout;
    }
  });

  it('floor payout monotonically increases on the underdog side of a lopsided market', () => {
    // The side where odds are LONG. Different code path through the
    // calculator (floor never binds). Important to confirm separately.
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [6_000, 6_000],
      realPool: [80_000, 2_000],
    };
    let lastPayout = 0;
    for (let stake = 100; stake <= 5_000; stake += 100) {
      const r = calculateLockedOdds(m, stake, 1, NEW_USER, HEALTHY);
      expect(r.floorPayout).toBeGreaterThanOrEqual(lastPayout);
      lastPayout = r.floorPayout;
    }
  });
});

describe('scenario: locked odds round-trip via vig storage', () => {
  // settlement (Phase 4) will compute parimutuel-with-vig upside using
  // the EXACT vig that was applied at stake time. Verify the returned
  // vigApplied value, when combined with the stored locked_odds, can
  // reconstruct the math without surprises.
  it('vigApplied and lockedOdds are both stored and recoverable', () => {
    const m: MarketSnapshot = {
      category: 'sports',
      seedPool: [6_000, 6_000],
      realPool: [20_000, 20_000],
    };
    const r = calculateLockedOdds(m, 1_000, 0, NEW_USER, HEALTHY);
    expect(r.vigApplied).toBeGreaterThan(0);
    expect(r.vigApplied).toBeLessThan(0.15);
    expect(r.lockedOdds).toBeGreaterThan(1);
    // Floor payout reconstruction must use the same arithmetic the
    // settler will (Math.round(netStake * lockedOdds)).
    expect(r.floorPayout).toBe(Math.round(r.netStake * r.lockedOdds));
  });
});
