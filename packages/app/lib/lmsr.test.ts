import { describe, it, expect } from 'vitest';
import {
  lmsrCost, lmsrPrices, rawTradeCost, quoteTrade, wouldFormCompleteSet,
  proRataUnwind, bFromExposure, maxSubsidyNaira, expectedSubsidyNaira,
  KOBO_PER_NAIRA, MIN_TRADE_KOBO, TRADE_FEE_PCT, sharesForBudget,
} from './lmsr';

// This engine prices real money and the house is the counterparty on every
// trade. An adversarial review found five distinct ways a naive LMSR is
// exploitable; each is reproduced below as a regression test so it cannot
// come back silently. Tests named "ATTACK:" encode a specific exploit.

const b = 10_000;
const binary = () => [0, 0];

describe('cost function and prices', () => {
  it('starts every outcome at 1/N', () => {
    expect(lmsrPrices([0, 0], b)).toEqual([0.5, 0.5]);
    lmsrPrices([0, 0, 0, 0], b).forEach(p => expect(p).toBeCloseTo(0.25, 12));
  });

  it('prices always sum to 1, however lopsided the book', () => {
    for (const q of [[0, 0], [50_000, 0], [0, 90_000], [12_345, 67_890], [1e6, 3]]) {
      expect(lmsrPrices(q, b).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 10);
    }
    const many = [500_000, 1_000, 250_000, 3, 90_000];
    expect(lmsrPrices(many, b).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 10);
  });

  it('C(0) = b·ln(N)', () => {
    expect(lmsrCost([0, 0], b)).toBeCloseTo(b * Math.log(2), 6);
    expect(lmsrCost([0, 0, 0, 0, 0], b)).toBeCloseTo(b * Math.log(5), 6);
  });

  it('buying raises that outcome and lowers the others', () => {
    const before = lmsrPrices([0, 0], b);
    const after = lmsrPrices([5_000, 0], b);
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[1]).toBeLessThan(before[1]);
  });
});

describe('ATTACK: numerical overflow gives away free positions', () => {
  // exp(q/b) is Infinity for q/b > ~709. Infinity − Infinity is NaN, and a
  // caller treating NaN as "no cost" hands out a free position.
  it('stays finite at extreme q where a naive exp() overflows', () => {
    expect(Math.exp(10_000_000 / b)).toBe(Infinity);        // the naive form dies
    expect(Number.isFinite(lmsrCost([10_000_000, 0], b))).toBe(true);
    expect(Number.isFinite(lmsrCost([1e9, 1e9, 0], b))).toBe(true);
    const cost = rawTradeCost([10_000_000, 0], b, 0, 1_000);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });

  it('prices remain valid probabilities at extreme q', () => {
    const p = lmsrPrices([10_000_000, 0], b);
    expect(p[0]).toBeCloseTo(1, 10);
    expect(p[1]).toBeCloseTo(0, 10);
    expect(p.every(x => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
  });
});

describe('ATTACK: rounding dust farmed by trade-splitting', () => {
  it('rounds against the user in both directions', () => {
    const buy = quoteTrade(binary(), b, 0, 1_000, 0);
    expect(buy.costKobo).toBeGreaterThanOrEqual(rawTradeCost(binary(), b, 0, 1_000) * KOBO_PER_NAIRA);

    // A sell's cost is negative (money flows to the user). Rounding must
    // shrink the MAGNITUDE the user receives, never grow it — the bug the
    // first version of this file shipped.
    const q = [50_000, 0];
    const sell = quoteTrade(q, b, 0, -1_000, 50_000);
    expect(sell.costKobo).toBeLessThanOrEqual(0);
    expect(Math.abs(sell.costKobo)).toBeLessThanOrEqual(
      Math.abs(rawTradeCost(q, b, 0, -1_000)) * KOBO_PER_NAIRA,
    );
  });

  it('a buy/sell round trip never profits the user', () => {
    for (const size of [1_000, 5_000, 20_000]) {
      const buy = quoteTrade(binary(), b, 0, size, 0);
      const after = [size, 0];
      const sell = quoteTrade(after, b, 0, -size, size);
      // buy.totalKobo leaves the wallet (+), sell.totalKobo enters it (−)
      expect(buy.totalKobo + sell.totalKobo).toBeGreaterThan(0); // net loss to user
    }
  });

  it('all money is whole kobo — no sub-kobo dust exists', () => {
    for (const size of [1_000, 3_333, 7_777]) {
      const qt = quoteTrade(binary(), b, 0, size, 0);
      expect(Number.isInteger(qt.costKobo)).toBe(true);
      expect(Number.isInteger(qt.feeKobo)).toBe(true);
      expect(Number.isInteger(qt.totalKobo)).toBe(true);
    }
  });
});

describe('ATTACK: fee avoided by subdivision (LMSR is path-independent)', () => {
  it('rejects trades below the minimum, where the fee would round away', () => {
    expect(() => quoteTrade(binary(), b, 0, 1, 0)).toThrow(/minimum/);
    expect(() => quoteTrade(binary(), b, 0, 10, 0)).toThrow(/minimum/);
  });

  it('splitting a trade costs MORE in fees, never less', () => {
    const oneBig = quoteTrade(binary(), b, 0, 20_000, 0);

    // Walk the same 20,000 shares in 10 legs, repricing each time.
    let q = binary();
    let held = 0, paid = 0, fees = 0;
    for (let i = 0; i < 10; i++) {
      const leg = quoteTrade(q, b, 0, 2_000, held);
      paid += leg.totalKobo; fees += leg.feeKobo; held += 2_000;
      q = [q[0] + 2_000, q[1]];
    }
    expect(fees).toBeGreaterThanOrEqual(oneBig.feeKobo);
    expect(paid).toBeGreaterThanOrEqual(oneBig.totalKobo);
  });

  it('always charges a positive fee', () => {
    const qt = quoteTrade(binary(), b, 0, MIN_TRADE_KOBO / KOBO_PER_NAIRA * 3, 0);
    expect(qt.feeKobo).toBeGreaterThan(0);
    expect(qt.feeKobo).toBeGreaterThanOrEqual(Math.abs(qt.costKobo) * TRADE_FEE_PCT - 1);
  });
});

describe('ATTACK: naked shorting makes house loss unbounded', () => {
  // Short YES ≡ long NO minus a ₦1/share loan. Proceeds asymptote to b·ln(N)
  // while the liability grows linearly, so the house eats the difference —
  // 13x the supposed hard bound at 100k shares.
  it('refuses to sell shares the user does not hold', () => {
    expect(() => quoteTrade(binary(), b, 0, -20_000, 0)).toThrow(/naked short/);
    expect(() => quoteTrade([50_000, 0], b, 0, -50_000, 1_000)).toThrow(/naked short/);
  });

  it('allows selling exactly what is held', () => {
    expect(() => quoteTrade([20_000, 0], b, 0, -20_000, 20_000)).not.toThrow();
  });

  it('demonstrates the loss it prevents', () => {
    // What a naked 100k short would have paid out vs what it would owe.
    const proceeds = Math.abs(rawTradeCost(binary(), b, 0, -100_000));
    const liability = 100_000;
    expect(proceeds).toBeLessThan(maxSubsidyNaira(b, 2) + 1);   // capped
    expect(liability - proceeds).toBeGreaterThan(90_000);        // house's loss, uncapped
  });
});

describe('ATTACK: complete set is a risk-free instrument', () => {
  it('buying every outcome costs exactly the guaranteed payout', () => {
    for (const D of [1_000, 5_000, 25_000]) {
      let q = binary();
      const yes = rawTradeCost(q, b, 0, D); q = [q[0] + D, q[1]];
      const no = rawTradeCost(q, b, 1, D);
      expect(yes + no).toBeCloseTo(D, 6);   // cost == payout, exactly
    }
  });

  it('the same holds for multi-outcome', () => {
    const N = 5, D = 3_000;
    let q = new Array(N).fill(0);
    let total = 0;
    for (let i = 0; i < N; i++) {
      total += rawTradeCost(q, b, i, D);
      q = q.map((v, j) => (j === i ? v + D : v));
    }
    expect(total).toBeCloseTo(D, 6);
  });

  it('detects a trade that would complete a set', () => {
    expect(wouldFormCompleteSet([100, 0], 1, 50)).toBe(true);
    expect(wouldFormCompleteSet([100, 0], 0, 50)).toBe(false);
    expect(wouldFormCompleteSet([10, 10, 0], 2, 5)).toBe(true);
    expect(wouldFormCompleteSet([10, 10, 0], 0, 5)).toBe(false);
  });
});

describe('ATTACK: flat-price unwind drains the subsidy risk-free', () => {
  it('a snapshot price pays out MORE than the book ever collected', () => {
    const q = [30_000, 0];
    const collected = lmsrCost(q, b) - lmsrCost(binary(), b);
    const flat = lmsrPrices(q, b)[0] * 30_000;
    expect(flat).toBeGreaterThan(collected);          // the gap is free money
    expect(flat - collected).toBeGreaterThan(2_000);  // and it is not small
  });

  it('pro-rata unwind distributes exactly what was collected, never more', () => {
    const q = [30_000, 0];
    const holders = [
      { outcomeIdx: 0, shares: 10_000 },
      { outcomeIdx: 0, shares: 15_000 },
      { outcomeIdx: 0, shares: 5_000 },
    ];
    const payouts = proRataUnwind(q, binary(), b, holders);
    const collectedKobo = (lmsrCost(q, b) - lmsrCost(binary(), b)) * KOBO_PER_NAIRA;
    const paid = payouts.reduce((s, p) => s + p, 0);
    expect(paid).toBeLessThanOrEqual(Math.ceil(collectedKobo));
    expect(paid).toBeGreaterThan(collectedKobo - holders.length - 1); // only rounding lost
  });

  it('is order-independent — no incentive to race for the exit', () => {
    const q = [30_000, 0];
    const holders = [
      { outcomeIdx: 0, shares: 10_000 },
      { outcomeIdx: 0, shares: 10_000 },
      { outcomeIdx: 0, shares: 10_000 },
    ];
    const payouts = proRataUnwind(q, binary(), b, holders);
    expect(payouts[0]).toBe(payouts[1]);
    expect(payouts[1]).toBe(payouts[2]);   // identical positions, identical payout
  });
});

describe('exposure: b derived from a target, not fixed', () => {
  it('holds worst-case loss constant across outcome counts', () => {
    for (const N of [2, 3, 5, 10]) {
      const bN = bFromExposure(7_000, N);
      expect(maxSubsidyNaira(bN, N)).toBeCloseTo(7_000, 6);
    }
  });

  it('a FIXED b would have risked 3.3x more on a 10-outcome market', () => {
    expect(maxSubsidyNaira(10_000, 10) / maxSubsidyNaira(10_000, 2)).toBeCloseTo(3.32, 1);
  });

  it('rejects degenerate outcome counts', () => {
    expect(() => bFromExposure(7_000, 1)).toThrow();
  });
});

describe('expected subsidy is entropy-based, not a flat 40%', () => {
  // Realised subsidy = b·ln(N·p_win); expected = b·(ln N − H(p)). Markets that
  // resolve get arbitraged to 0.95+ first, so the true figure is 71–99% of the
  // bound. The original 40% assumption made a loss-making fleet look profitable.
  it('matches the closed form for a resolved market', () => {
    const q = [40_000, 0];
    const pWin = lmsrPrices(q, b)[0];
    const empirical = q[0] - (lmsrCost(q, b) - lmsrCost(binary(), b)); // payout − collected
    expect(empirical).toBeCloseTo(b * Math.log(2 * pWin), 4);
  });

  it('is far above 40% of max once a market is confident', () => {
    const max = maxSubsidyNaira(b, 2);
    expect(expectedSubsidyNaira(b, [0.99, 0.01]) / max).toBeGreaterThan(0.90);
    expect(expectedSubsidyNaira(b, [0.95, 0.05]) / max).toBeGreaterThan(0.70);
  });

  it('is genuinely low for a market that stays uncertain', () => {
    const max = maxSubsidyNaira(b, 2);
    expect(expectedSubsidyNaira(b, [0.55, 0.45]) / max).toBeLessThan(0.05);
  });
});

describe('slippage guard operates on the post-fee number', () => {
  it('totalKobo is what actually leaves the wallet', () => {
    const qt = quoteTrade(binary(), b, 0, 5_000, 0);
    expect(qt.totalKobo).toBe(qt.costKobo + qt.feeKobo);
    // Guarding on costKobo instead would be 1.5% looser than the user believes.
    expect(qt.totalKobo).toBeGreaterThan(qt.costKobo);
  });

  it('a sell returns less than the raw proceeds, after fee', () => {
    const q = [20_000, 0];
    const sell = quoteTrade(q, b, 0, -5_000, 20_000);
    expect(sell.totalKobo).toBeLessThan(0);                        // money enters wallet
    expect(Math.abs(sell.totalKobo)).toBeLessThan(Math.abs(sell.costKobo)); // fee taken
  });
});

describe('pro-rata is valid ONLY for a terminal whole-book unwind', () => {
  it('distributes exactly the pool when EVERY holder exits', () => {
    const q = [30_000, 0];
    const holders = [0, 1, 2].map(() => ({ outcomeIdx: 0, shares: 10_000 }));
    const paid = proRataUnwind(q, [0, 0], b, holders).reduce((s, p) => s + p, 0);
    const pool = (lmsrCost(q, b) - lmsrCost([0, 0], b)) * KOBO_PER_NAIRA;
    expect(paid).toBeLessThanOrEqual(Math.ceil(pool));
    expect(paid).toBeGreaterThan(pool - holders.length - 1);
  });

  it('ATTACK: paying only a SUBSET pro-rata taxes the holders who stayed', () => {
    // The bug this comment block exists to prevent. Pay 1 of 3 holders
    // pro-rata, then decrement q by their shares: the pool falls by MORE than
    // was paid out, and the difference is borne by whoever rolled.
    const q = [30_000, 0];
    const poolBefore = lmsrCost(q, b) - lmsrCost([0, 0], b);
    // All three ARE holders — only the first elects to exit. Their pro-rata
    // share is therefore computed against the full book, exactly as it would
    // be at a horizon. (Passing only the leaver would hand them the entire
    // pool, which is a different — and even worse — bug.)
    const allThree = [0, 1, 2].map(() => ({ outcomeIdx: 0, shares: 10_000 }));
    const paidOne = proRataUnwind(q, [0, 0], b, allThree)[0] / KOBO_PER_NAIRA;
    const poolAfter = lmsrCost([20_000, 0], b) - lmsrCost([0, 0], b);
    const taxedTheStayers = (poolBefore - poolAfter) - paidOne;
    expect(taxedTheStayers).toBeGreaterThan(1_000);   // ~₦1,365 on this book
  });

  it('a curve-priced sell telescopes exactly — the correct horizon mechanism', () => {
    let q = [30_000, 0];
    let total = 0;
    for (let i = 0; i < 3; i++) {
      total += Math.abs(rawTradeCost(q, b, 0, -10_000));
      q = [q[0] - 10_000, q[1]];
    }
    const collected = lmsrCost([30_000, 0], b) - lmsrCost([0, 0], b);
    expect(total).toBeCloseTo(collected, 6);          // house-neutral, exactly
  });
});

describe('sharesForBudget — naira in, shares out', () => {
  const b = 10000;
  const q = [0, 0];

  it('never spends more than the budget', () => {
    for (const budget of [100, 250, 1000, 5000, 25000, 100000]) {
      const shares = sharesForBudget(q, b, 0, budget);
      if (shares === 0) continue;
      const cost = quoteTrade(q, b, 0, shares, 0).totalKobo / KOBO_PER_NAIRA;
      expect(cost).toBeLessThanOrEqual(budget + 1e-9);
    }
  });

  it('gets close to the budget rather than leaving most of it unspent', () => {
    // A binary search that bailed early, or an off-by-one in the bound, would
    // still "never overspend" while buying almost nothing — so cheapness on
    // its own is not evidence the function works.
    const budget = 5000;
    const shares = sharesForBudget(q, b, 0, budget);
    const cost = quoteTrade(q, b, 0, shares, 0).totalKobo / KOBO_PER_NAIRA;
    expect(cost).toBeGreaterThan(budget * 0.99);
  });

  it('one more share would breach the budget', () => {
    const budget = 3000;
    const shares = sharesForBudget(q, b, 0, budget);
    const over = quoteTrade(q, b, 0, shares + 1, 0).totalKobo / KOBO_PER_NAIRA;
    expect(over).toBeGreaterThan(budget);
  });

  it('is monotonic — more money never buys fewer shares', () => {
    let prev = 0;
    for (const budget of [100, 500, 1000, 2000, 5000, 10000, 50000]) {
      const shares = sharesForBudget(q, b, 0, budget);
      expect(shares).toBeGreaterThanOrEqual(prev);
      prev = shares;
    }
  });

  it('buys fewer shares of an outcome the book has already bid up', () => {
    const skewed = [40000, 0];   // outcome 0 is now expensive
    const cheap = sharesForBudget(skewed, b, 1, 5000);
    const dear = sharesForBudget(skewed, b, 0, 5000);
    expect(dear).toBeLessThan(cheap);
  });

  it('returns 0 for nothing, negatives and nonsense rather than throwing', () => {
    expect(sharesForBudget(q, b, 0, 0)).toBe(0);
    expect(sharesForBudget(q, b, 0, -100)).toBe(0);
    expect(sharesForBudget(q, b, 0, NaN)).toBe(0);
  });
});
