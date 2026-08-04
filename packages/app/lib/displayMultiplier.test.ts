import { describe, it, expect } from 'vitest';
import {
  displayFloorPayout,
  TIER1_FLOOR,
  TIER2_FLOOR,
  TIER2_MIN_STAKE,
  ENTRY_RAKE_PCT,
} from './displayMultiplier';

// displayFloorPayout is a PROMISE, not decoration: the backend refunds a
// voided parimutuel bet at MAX(net_stake, floor_payout). So these tests pin
// the guarantee the user is shown — especially the tier boundary, which
// exists specifically to prevent a ₦499 stake advertising a better floor
// than ₦500 (the bait-and-switch this mechanic was built to kill).

const net = (stake: number) => stake * (1 - ENTRY_RAKE_PCT);

describe('displayFloorPayout — guards', () => {
  it('returns a zero payout for non-positive / non-finite stakes', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(displayFloorPayout(bad)).toEqual({ multiplier: 1, payout: 0 });
    }
  });
});

describe('displayFloorPayout — tiers', () => {
  it('applies the Tier 1 floor below the Tier 2 minimum stake', () => {
    const r = displayFloorPayout(100);
    expect(r.multiplier).toBe(TIER1_FLOOR);
    expect(r.payout).toBe(Math.round(net(100) * TIER1_FLOOR));
  });

  it('collapses to the plain Tier 2 floor at large stakes', () => {
    const r = displayFloorPayout(100_000);
    expect(r.multiplier).toBeCloseTo(TIER2_FLOOR, 10);
    expect(r.payout).toBe(Math.round(net(100_000) * TIER2_FLOOR));
  });

  it('treats exactly the Tier 2 minimum as Tier 2', () => {
    // At the boundary the monotonic lift makes the effective multiplier
    // TIER1_FLOOR, so ₦500 is never worse than ₦499.
    const r = displayFloorPayout(TIER2_MIN_STAKE);
    expect(r.multiplier).toBeCloseTo(TIER1_FLOOR, 10);
  });
});

describe('displayFloorPayout — boundary monotonicity (the anti-bait-and-switch rule)', () => {
  it('never lets a ₦499 stake out-earn a ₦500 stake', () => {
    const just_below = displayFloorPayout(TIER2_MIN_STAKE - 1);
    const at_boundary = displayFloorPayout(TIER2_MIN_STAKE);
    expect(at_boundary.payout).toBeGreaterThanOrEqual(just_below.payout);
  });

  it('keeps payout non-decreasing across the whole boundary region', () => {
    let prev = -1;
    for (let stake = 450; stake <= 700; stake += 1) {
      const { payout } = displayFloorPayout(stake);
      expect(payout).toBeGreaterThanOrEqual(prev);
      prev = payout;
    }
  });

  it('never drops the multiplier below the Tier 2 floor', () => {
    for (let stake = TIER2_MIN_STAKE; stake <= 5000; stake += 37) {
      expect(displayFloorPayout(stake).multiplier).toBeGreaterThanOrEqual(TIER2_FLOOR - 1e-12);
    }
  });

  it('decays the lifted multiplier toward TIER2_FLOOR across the lift band', () => {
    // The lift only exceeds TIER2_FLOOR while
    //   (TIER2_MIN_STAKE * TIER1_FLOOR) / stake > TIER2_FLOOR
    // i.e. stake < 500 * 1.03 / 1.02 ≈ 504.9. Past that it is exactly
    // TIER2_FLOOR. Pin both the decay inside the band and the collapse after.
    const bandEnd = (TIER2_MIN_STAKE * TIER1_FLOOR) / TIER2_FLOOR; // ≈ 504.9
    expect(displayFloorPayout(501).multiplier)
      .toBeGreaterThan(displayFloorPayout(504).multiplier);
    expect(displayFloorPayout(504).multiplier).toBeGreaterThan(TIER2_FLOOR);
    expect(displayFloorPayout(Math.ceil(bandEnd)).multiplier).toBeCloseTo(TIER2_FLOOR, 10);
    expect(displayFloorPayout(TIER2_MIN_STAKE * 20).multiplier).toBeCloseTo(TIER2_FLOOR, 10);
  });
});

describe('displayFloorPayout — the guarantee itself', () => {
  it('always floors at or above the net stake (a void refund never loses money vs net)', () => {
    for (const stake of [1, 50, 499, 500, 501, 1000, 25_000]) {
      expect(displayFloorPayout(stake).payout).toBeGreaterThanOrEqual(Math.floor(net(stake)));
    }
  });

  it('returns an integer payout (naira, no kobo drift)', () => {
    for (const stake of [123, 499, 500, 777, 9999]) {
      expect(Number.isInteger(displayFloorPayout(stake).payout)).toBe(true);
    }
  });
});
