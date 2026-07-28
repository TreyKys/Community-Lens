import { describe, it, expect } from 'vitest';
import { calculatePotentialPayout, ENTRY_RAKE_PCT, POOL_RAKE_PCT } from './payout';

// calculatePotentialPayout drives the "if you win" preview users see BEFORE
// staking. If it overstates a payout the user is effectively mis-sold, so the
// invariants below (never promise more than the post-rake pool, always agree
// with the resolve-time formula) matter more than any single number.

describe('calculatePotentialPayout — guards', () => {
  it('rejects non-positive or non-finite stakes', () => {
    expect(calculatePotentialPayout(0, [100, 100], 0)).toBeNull();
    expect(calculatePotentialPayout(-50, [100, 100], 0)).toBeNull();
    expect(calculatePotentialPayout(NaN, [100, 100], 0)).toBeNull();
    expect(calculatePotentialPayout(Infinity, [100, 100], 0)).toBeNull();
  });

  it('rejects an out-of-range outcome index', () => {
    expect(calculatePotentialPayout(100, [100, 100], -1)).toBeNull();
    expect(calculatePotentialPayout(100, [100, 100], 2)).toBeNull();
  });

  it('treats negative / non-finite pools as empty rather than throwing', () => {
    const r = calculatePotentialPayout(100, [-500, NaN], 0);
    expect(r).not.toBeNull();
    // Both pools sanitised to 0 → this is a first-mover bet on an empty book.
    expect(r!.isFirstMover).toBe(true);
    expect(Number.isFinite(r!.payout)).toBe(true);
  });
});

describe('calculatePotentialPayout — math', () => {
  it('matches the documented formula on a balanced book', () => {
    const stake = 1000;
    const pools = [5000, 5000];
    const r = calculatePotentialPayout(stake, pools, 0)!;

    const net = stake * (1 - ENTRY_RAKE_PCT);       // 985
    const winningPool = 5000 + net;
    const payoutPool = (10000 + net) * (1 - POOL_RAKE_PCT);
    const expected = (net / winningPool) * payoutPool;

    expect(r.payout).toBeCloseTo(expected, 6);
    expect(r.profit).toBeCloseTo(expected - stake, 6);
    expect(r.multiplier).toBeCloseTo(expected / stake, 6);
  });

  it('never pays more than the post-rake pool (the house always keeps its cut)', () => {
    const stake = 1000;
    const pools = [200, 8000];
    const r = calculatePotentialPayout(stake, pools, 0)!;
    const newTotal = 8200 + stake * (1 - ENTRY_RAKE_PCT);
    expect(r.payout).toBeLessThanOrEqual(newTotal * (1 - POOL_RAKE_PCT) + 1e-9);
  });

  it('pays MORE for backing the unpopular side', () => {
    const pools = [1000, 9000];
    const underdog = calculatePotentialPayout(500, pools, 0)!;
    const favourite = calculatePotentialPayout(500, pools, 1)!;
    expect(underdog.multiplier).toBeGreaterThan(favourite.multiplier);
  });

  it('dilutes the payout as your own stake grows (self-impact)', () => {
    const pools = [1000, 1000];
    const small = calculatePotentialPayout(100, pools, 0)!;
    const large = calculatePotentialPayout(5000, pools, 0)!;
    expect(large.multiplier).toBeLessThan(small.multiplier);
  });
});

describe('calculatePotentialPayout — implied probability', () => {
  it('reports the crowd probability from the CURRENT pools', () => {
    const r = calculatePotentialPayout(100, [2500, 7500], 0)!;
    expect(r.impliedProb).toBeCloseTo(0.25, 10);
  });

  it('falls back to a uniform split on a completely empty book', () => {
    expect(calculatePotentialPayout(100, [0, 0], 0)!.impliedProb).toBeCloseTo(0.5, 10);
    expect(calculatePotentialPayout(100, [0, 0, 0, 0], 2)!.impliedProb).toBeCloseTo(0.25, 10);
  });
});

describe('calculatePotentialPayout — first-mover flag', () => {
  it('flags a bet with nothing staked on the other side', () => {
    // Only the selected outcome has money → nobody to lose to → void/refund.
    expect(calculatePotentialPayout(100, [1000, 0], 0)!.isFirstMover).toBe(true);
    expect(calculatePotentialPayout(100, [0, 0], 0)!.isFirstMover).toBe(true);
  });

  it('does not flag once any opposing stake exists', () => {
    expect(calculatePotentialPayout(100, [1000, 1], 0)!.isFirstMover).toBe(false);
  });

  it('looks only at OPPOSING money, not the selected outcome', () => {
    // Selected side empty but opponents funded — a real, settleable bet.
    expect(calculatePotentialPayout(100, [0, 5000], 0)!.isFirstMover).toBe(false);
  });
});
