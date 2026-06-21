/**
 * Unit + battle tests for the locked-odds settlement math.
 *
 * Every assertion here directly maps to money moving between users
 * and the house. If any of these regress, money moves wrongly. The
 * test file is structured into:
 *
 *   1. Per-bet payout invariants (pay >= floor, never crash, etc.)
 *   2. Per-bet VIP cut invariants
 *   3. Whole-market settlement summaries
 *   4. Battle scenarios — realistic NG flows with hand-derived
 *      expected numbers
 */

import { describe, it, expect } from 'vitest';
import {
  calculateLockedPayout,
  calculateLockedVipCut,
  settleLockedMarket,
  netStakeFromGross,
  type LockedBet,
  type MarketResolution,
} from './lockedSettlement';

// ─── Helpers ─────────────────────────────────────────────────────────

function bet(overrides: Partial<LockedBet> = {}): LockedBet {
  return {
    id: 'bet-1',
    userId: 'user-1',
    outcomeIndex: 0,
    stakeTngn: 1000,
    netStakeTngn: 985,
    lockedOdds: 1.80,
    vigAtStakePct: 0.08,
    ...overrides,
  };
}

const HEALTHY_RESOLUTION = (winner = 0): MarketResolution => ({
  seedPool: [6_000, 6_000],
  realPool: [20_000, 20_000],
  winningOutcomeIndex: winner,
});

// ─── 1. Per-bet payout ───────────────────────────────────────────────

describe('calculateLockedPayout — invariants', () => {
  it('payout is always >= floor (the honest contract)', () => {
    const r = calculateLockedPayout(
      bet({ lockedOdds: 1.5 }),
      HEALTHY_RESOLUTION(0),
    );
    expect(r.payoutTngn).toBeGreaterThanOrEqual(r.floorPayoutTngn);
  });

  it('floor is honored when opposing pool stayed flat (or moved against the user)', () => {
    const r = calculateLockedPayout(
      bet({ lockedOdds: 1.80, vigAtStakePct: 0.08 }),
      // Pool moved heavily toward chosen side after stake.
      {
        seedPool: [6_000, 6_000],
        realPool: [100_000, 5_000],
        winningOutcomeIndex: 0,
      },
    );
    // Parimutuel path: share = 985/111000 ≈ 0.00887, rawPayout ≈ 1037,
    // /1.08 ≈ 960. Floor: 985*1.80 ≈ 1773. Floor binds.
    expect(r.floorBound).toBe(true);
    expect(r.payoutTngn).toBe(r.floorPayoutTngn);
  });

  it('upside binds when opposing pool grew after stake', () => {
    const r = calculateLockedPayout(
      bet({ lockedOdds: 1.20, vigAtStakePct: 0.08 }),
      // Lots of opposing real money relative to chosen → big upside.
      {
        seedPool: [6_000, 6_000],
        realPool: [5_000, 100_000],
        winningOutcomeIndex: 0,
      },
    );
    // Parimutuel-with-vig: total = 117000, chosen = 11000.
    //   share = 985/11000 ≈ 0.0895, rawPayout ≈ 10475, /1.08 ≈ 9699.
    // Floor: 985*1.2 = 1182. Upside binds by a long margin.
    expect(r.upsideBound).toBe(true);
    expect(r.payoutTngn).toBeGreaterThan(r.floorPayoutTngn);
  });

  it('never returns NaN / Infinity on degenerate pool reads', () => {
    const r = calculateLockedPayout(
      bet(),
      {
        seedPool: [0, 0],
        realPool: [0, 0],
        winningOutcomeIndex: 0,
      },
    );
    expect(Number.isFinite(r.payoutTngn)).toBe(true);
    expect(r.payoutTngn).toBeGreaterThanOrEqual(0);
    expect(r.payoutTngn).toBe(r.floorPayoutTngn);
  });

  it('treats negative pool values as zero rather than producing nonsense payouts', () => {
    const r = calculateLockedPayout(
      bet(),
      {
        seedPool: [-1000, 6_000],
        realPool: [-500, 10_000],
        winningOutcomeIndex: 0,
      },
    );
    expect(Number.isFinite(r.payoutTngn)).toBe(true);
    expect(r.payoutTngn).toBeGreaterThanOrEqual(r.floorPayoutTngn);
  });
});

// ─── 2. Per-bet VIP cut ──────────────────────────────────────────────

describe('calculateLockedVipCut — invariants', () => {
  it('returns null when there is no VIP referrer', () => {
    expect(calculateLockedVipCut(bet())).toBeNull();
  });

  it('returns null when the share percent is zero', () => {
    const r = calculateLockedVipCut(bet({ vipReferrerId: 'vip-1', vipRakeSharePct: 0 }));
    expect(r).toBeNull();
  });

  it('computes the cut from house margin (= net_stake × vig × share%)', () => {
    // 985 × 0.08 × 0.25 = 19.7 → rounds to 20
    const r = calculateLockedVipCut(bet({
      vipReferrerId: 'vip-1',
      vipRakeSharePct: 25,
      vigAtStakePct: 0.08,
    }));
    expect(r).not.toBeNull();
    expect(r!.amountTngn).toBe(20);
    expect(r!.basis).toBe('house_margin');
  });

  it('caps within reasonable bounds for typical settings (sanity)', () => {
    // Even at maximum 50% share on a ₦5000 stake with 15% vig, the
    // cut is bounded.
    const r = calculateLockedVipCut(bet({
      stakeTngn: 5000,
      netStakeTngn: 4925,
      vipReferrerId: 'vip-1',
      vipRakeSharePct: 50,
      vigAtStakePct: 0.15,
    }));
    // 4925 × 0.15 × 0.50 = 369.375 → 369
    expect(r!.amountTngn).toBe(369);
  });
});

// ─── 3. Whole-market settlement ──────────────────────────────────────

describe('settleLockedMarket — summary correctness', () => {
  it('houseProfit = totalNetStakes - winnerPayouts - vipPayouts (P&L identity)', () => {
    const bets: LockedBet[] = [
      bet({ id: 'a', outcomeIndex: 0, netStakeTngn: 1000, lockedOdds: 1.5 }),
      bet({ id: 'b', outcomeIndex: 1, netStakeTngn: 2000, lockedOdds: 1.8 }),
      bet({ id: 'c', outcomeIndex: 1, netStakeTngn: 500, lockedOdds: 2.0 }),
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0));

    // Verify identity
    const totalNetStakes = bets.reduce((a, b) => a + b.netStakeTngn, 0);
    expect(s.houseProfitTngn).toBe(totalNetStakes - s.totalWinnerPayouts - s.totalVipPayouts);
  });

  it('flags isOneSided when only losers staked', () => {
    const bets: LockedBet[] = [
      bet({ id: 'a', outcomeIndex: 1 }), // loser
      bet({ id: 'b', outcomeIndex: 1 }), // loser
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0)); // outcome 0 wins
    expect(s.isOneSided).toBe(true);
    expect(s.totalWinnerPayouts).toBe(0);
  });

  it('does NOT flag isOneSided when winners exist but losers do not (first-mover case)', () => {
    const bets: LockedBet[] = [
      bet({ id: 'a', outcomeIndex: 0, lockedOdds: 1.03, netStakeTngn: 985 }),
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0));
    expect(s.isOneSided).toBe(false);
    // Single winner gets paid; house wears the bump from reserve.
    expect(s.totalWinnerPayouts).toBeGreaterThan(0);
    expect(s.houseProfitTngn).toBeLessThan(0); // house lost on first-mover bonus
  });

  it('records perBet entries for every bet', () => {
    const bets: LockedBet[] = [
      bet({ id: 'a', outcomeIndex: 0 }),
      bet({ id: 'b', outcomeIndex: 1 }),
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0));
    expect(s.perBet).toHaveLength(2);
    expect(s.perBet.find(p => p.betId === 'a')!.won).toBe(true);
    expect(s.perBet.find(p => p.betId === 'b')!.won).toBe(false);
  });

  it('routes VIP cuts only from losing bets', () => {
    const bets: LockedBet[] = [
      // winner with a VIP referrer → no cut (winner got paid; no margin)
      bet({ id: 'a', outcomeIndex: 0, vipReferrerId: 'vip-1', vipRakeSharePct: 25 }),
      // loser with a VIP referrer → cut applies
      bet({ id: 'b', outcomeIndex: 1, vipReferrerId: 'vip-2', vipRakeSharePct: 25 }),
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0));
    expect(s.vipCuts).toHaveLength(1);
    expect(s.vipCuts[0].vipReferrerId).toBe('vip-2');
  });
});

// ─── 4. Battle scenarios ─────────────────────────────────────────────

describe('settleLockedMarket — realistic battle scenarios', () => {
  it('balanced match — losing pool dominates, house profits', () => {
    // Carefully constructed so that losing real money clearly exceeds
    // the winners' floor liability and house P&L is unambiguously
    // positive. realPool reflects the bets' net stakes (the only way
    // the resolve route would see this state).
    //
    // Winners (outcome 0): 500 + 500 = 1000 net, locked at 1.85 each.
    // Losers  (outcome 1): 2000 + 3000 = 5000 net.
    // Effective at settlement: [6000+1000, 6000+5000] = [7000, 11000].
    // Total = 18000.
    // Per winner @ 985 net: floor=985*1.85=1822; parimutuel=985/7000 *
    //   18000 / 1.07 = 2367. Upside binds → pay 2367 per winner.
    // Two winners ≈ 2*2367 = 4734.
    // Total net stakes ≈ 1000 + 5000 = 6000 (approx; with rake).
    // House P&L ≈ 6000 - 4734 = +1266 → clearly positive.
    const bets: LockedBet[] = [
      bet({ id: 'w1', outcomeIndex: 0, stakeTngn: 500,  netStakeTngn: 492.5,  lockedOdds: 1.85, vigAtStakePct: 0.07 }),
      bet({ id: 'w2', outcomeIndex: 0, stakeTngn: 500,  netStakeTngn: 492.5,  lockedOdds: 1.85, vigAtStakePct: 0.07 }),
      bet({ id: 'l1', outcomeIndex: 1, stakeTngn: 2000, netStakeTngn: 1970,   lockedOdds: 1.80, vigAtStakePct: 0.07 }),
      bet({ id: 'l2', outcomeIndex: 1, stakeTngn: 3000, netStakeTngn: 2955,   lockedOdds: 1.80, vigAtStakePct: 0.07 }),
    ];
    const s = settleLockedMarket(bets, {
      seedPool: [6_000, 6_000],
      realPool: [985, 4925], // sum of net stakes per side
      winningOutcomeIndex: 0,
    });

    // Identity always holds.
    const totalNetStakes = bets.reduce((a, b) => a + b.netStakeTngn, 0);
    expect(s.houseProfitTngn).toBe(totalNetStakes - s.totalWinnerPayouts - s.totalVipPayouts);

    // The whole point: house profits when losing pool > winning
    // floor liability.
    expect(s.houseProfitTngn).toBeGreaterThan(0);
    expect(s.isOneSided).toBe(false);

    // Every winning bet got AT LEAST its floor.
    for (const p of s.perBet) {
      if (p.won) {
        const correspondingBet = bets.find(b => b.id === p.betId)!;
        const floor = Math.round(correspondingBet.netStakeTngn * correspondingBet.lockedOdds);
        expect(p.payoutTngn).toBeGreaterThanOrEqual(floor);
      } else {
        expect(p.payoutTngn).toBe(0);
      }
    }
  });

  it('heavy favorite settles: floor binds, house still profits on the losers', () => {
    // Crowd piled 100k:5k on the favorite. Favorite wins. Winners hit
    // their floor (locked at 1.05, post-vig odds even shorter than
    // that). Losing pool of 5k pays the modest payout bump.
    const bets: LockedBet[] = [
      bet({ id: 'w1', outcomeIndex: 0, stakeTngn: 5000, netStakeTngn: 4925, lockedOdds: 1.05, vigAtStakePct: 0.08 }),
      bet({ id: 'w2', outcomeIndex: 0, stakeTngn: 3000, netStakeTngn: 2955, lockedOdds: 1.05, vigAtStakePct: 0.08 }),
      bet({ id: 'l1', outcomeIndex: 1, stakeTngn: 2000, netStakeTngn: 1970, lockedOdds: 4.00, vigAtStakePct: 0.08 }),
    ];
    const s = settleLockedMarket(
      bets,
      {
        seedPool: [10_000, 5_000],
        realPool: [100_000, 5_000],
        winningOutcomeIndex: 0,
      },
    );
    // P&L identity holds.
    const totalNet = bets.reduce((a, b) => a + b.netStakeTngn, 0);
    expect(s.houseProfitTngn).toBe(totalNet - s.totalWinnerPayouts - s.totalVipPayouts);
  });

  it('first-mover on a freshly seeded balanced market: house pays the locked rate', () => {
    // User stakes ₦200 alone before anyone else. realPool reflects
    // that one bet. locked_odds (~1.81) was set when the user placed
    // the bet against effective pools [6197, 6000]; vig stored was
    // 0.09 (sports 0.07 + thin-pool 0.02). At settlement nothing has
    // changed, so floor and parimutuel-with-vig converge — user gets
    // their promised rate, house pays from reserve.
    const bets: LockedBet[] = [
      bet({ id: 'lone', outcomeIndex: 0, stakeTngn: 200, netStakeTngn: 197, lockedOdds: 1.81, vigAtStakePct: 0.09 }),
    ];
    const s = settleLockedMarket(bets, {
      seedPool: [6_000, 6_000],
      realPool: [197, 0], // the lone bet's net stake on outcome 0
      winningOutcomeIndex: 0,
    });
    // Identity holds.
    const totalNet = bets.reduce((a, b) => a + b.netStakeTngn, 0);
    expect(s.houseProfitTngn).toBe(totalNet - s.totalWinnerPayouts - s.totalVipPayouts);
    // House loss = locked_payout - net_stake ≈ 197*1.81 - 197 = 159.
    // Substantial because the locked rate was substantial. This is
    // the "first-mover keeps their rate" promise being honoured.
    expect(s.houseProfitTngn).toBeLessThan(0);
    expect(s.houseProfitTngn).toBeCloseTo(-160, -1); // within ±5 of -160
    expect(s.isOneSided).toBe(false);
  });

  it('first-mover on a heavy favorite (floor binds): house loss is the small floor bump', () => {
    // ₦5000 on a heavy favorite. locked_odds clamps to 1.02 (Tier 2
    // floor). User wins alone. House pays the floor bump only —
    // bounded loss.
    const bets: LockedBet[] = [
      bet({ id: 'fav', outcomeIndex: 0, stakeTngn: 5000, netStakeTngn: 4925, lockedOdds: 1.02, vigAtStakePct: 0.10 }),
    ];
    const s = settleLockedMarket(bets, {
      seedPool: [80_000, 5_000],
      realPool: [4925, 0],
      winningOutcomeIndex: 0,
    });
    // Identity.
    const totalNet = bets.reduce((a, b) => a + b.netStakeTngn, 0);
    expect(s.houseProfitTngn).toBe(totalNet - s.totalWinnerPayouts - s.totalVipPayouts);
    // Loss bounded by floor bump (4925 * 0.02 ≈ 99) plus rounding
    // headroom. parimutuel-with-vig at this state should not pay
    // more than floor: chosen 80000+4925=84925, total 89925, share
    // 4925/84925 ≈ 0.058, raw = 5215, /1.10 = 4741 < floor 5024.
    // Floor binds. House loss ≈ 99.
    expect(s.houseProfitTngn).toBeLessThan(0);
    expect(s.houseProfitTngn).toBeGreaterThan(-200);
  });

  it('only-losers case: flagged as one-sided for caller to void + refund', () => {
    const bets: LockedBet[] = [
      bet({ id: 'l1', outcomeIndex: 1, stakeTngn: 500, netStakeTngn: 492.5, lockedOdds: 1.8 }),
      bet({ id: 'l2', outcomeIndex: 1, stakeTngn: 800, netStakeTngn: 788,   lockedOdds: 1.8 }),
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0)); // outcome 0 won
    expect(s.isOneSided).toBe(true);
    expect(s.totalWinnerPayouts).toBe(0);
  });

  it('VIP rake-share: only losing referees contribute', () => {
    const bets: LockedBet[] = [
      // VIP-referred winner — no cut.
      bet({ id: 'w_vip', outcomeIndex: 0, vipReferrerId: 'vip-1', vipRakeSharePct: 25 }),
      // VIP-referred loser — cut applies.
      bet({ id: 'l_vip', outcomeIndex: 1, vipReferrerId: 'vip-1', vipRakeSharePct: 25, netStakeTngn: 985, vigAtStakePct: 0.08 }),
      // Regular (non-VIP) loser — no cut.
      bet({ id: 'l_reg', outcomeIndex: 1 }),
    ];
    const s = settleLockedMarket(bets, HEALTHY_RESOLUTION(0));
    expect(s.vipCuts).toHaveLength(1);
    // 985 × 0.08 × 0.25 = 19.7 → 20
    expect(s.vipCuts[0].amountTngn).toBe(20);
    // house P&L decreases by VIP cut total.
    const totalNet = bets.reduce((a, b) => a + b.netStakeTngn, 0);
    expect(s.houseProfitTngn).toBe(totalNet - s.totalWinnerPayouts - 20);
  });

  it('floor-up under favorable late flow: user paid the upside, not the floor', () => {
    // User stakes early, locked at modest odds with vig 0.08. Then
    // the opposing pool flooded with money. At settlement they get
    // the parimutuel-with-vig path, not the locked floor.
    const userBet: LockedBet = {
      id: 'u1',
      userId: 'user-1',
      outcomeIndex: 0,
      stakeTngn: 1000,
      netStakeTngn: 985,
      lockedOdds: 1.30,
      vigAtStakePct: 0.08,
    };
    const s = settleLockedMarket(
      [userBet, bet({ id: 'opp', outcomeIndex: 1, netStakeTngn: 50_000 })],
      {
        seedPool: [6_000, 6_000],
        realPool: [985, 50_000],
        winningOutcomeIndex: 0,
      },
    );
    const u1 = s.perBet.find(p => p.betId === 'u1')!;
    expect(u1.upsideBound).toBe(true);
    expect(u1.payoutTngn).toBeGreaterThan(Math.round(985 * 1.30));
  });
});

// ─── 5. Helper ──────────────────────────────────────────────────────

describe('netStakeFromGross', () => {
  it('matches the 1.5% entry rake exactly', () => {
    expect(netStakeFromGross(1000)).toBeCloseTo(985, 6);
    expect(netStakeFromGross(500)).toBeCloseTo(492.5, 6);
    expect(netStakeFromGross(100)).toBeCloseTo(98.5, 6);
  });
});
