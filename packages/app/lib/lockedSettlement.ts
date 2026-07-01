/**
 * lib/lockedSettlement.ts
 *
 * Settlement math for locked-odds markets. The companion to
 * lib/lockedOdds.ts:
 *   - lockedOdds: at stake time, freezes a floor multiplier and stores
 *     the vig that was applied.
 *   - lockedSettlement: at resolution, pays each winner
 *
 *         MAX(floor_payout, parimutuel-with-vig)
 *
 *     using the SAME vig the user was quoted. This is the floor-up
 *     promise: the user's locked rate is the GUARANTEED minimum, and
 *     if opposing money landed after their stake, they get the
 *     parimutuel upside on top.
 *
 * Pure functions. No I/O, no DB, no React. Designed to be unit-tested
 * exhaustively, then called by the resolve route (TS) and by the
 * settle_market_locked RPC (SQL twin in a Phase 4b migration).
 *
 * Sign convention for house P&L: positive = profit, negative = loss.
 * Reserve INCREASES by house P&L on every settlement. Settling many
 * markets profitably grows the reserve and lifts dynamic stake caps;
 * a costly settlement shrinks it and can trigger auto-pause.
 */

import { ENTRY_RAKE_PCT } from './lockedOdds';

// ─── Public types ────────────────────────────────────────────────────

/**
 * Frozen per-bet state needed to settle. Mirrors the user_bets row.
 * Caller is responsible for reading the row and passing it in.
 */
export interface LockedBet {
  id: string;
  userId: string;
  outcomeIndex: number;
  stakeTngn: number;       // gross
  netStakeTngn: number;    // after entry rake
  lockedOdds: number;      // frozen multiplier
  vigAtStakePct: number;   // frozen vig
  /**
   * VIP referral split for this bet's referrer, if any. Zero / null
   * means no VIP rake share applies. Expressed as a percent
   * (0..50). Caller resolves this from referral_codes.
   */
  vipRakeSharePct?: number;
  vipReferrerId?: string;
}

/**
 * Final market state at resolution. seedPool is the house seed,
 * realPool is the sum of net stakes on each outcome (read from
 * markets.pool_by_outcome).
 */
export interface MarketResolution {
  seedPool: number[];
  realPool: number[];
  /** Primary/first winning outcome. Kept for back-compat with single-winner callers. */
  winningOutcomeIndex: number;
  /**
   * Full set of winning outcomes when a market resolves with more than
   * one correct outcome (ties, "either of these counts" rulings). When
   * omitted or empty, callers fall back to [winningOutcomeIndex].
   */
  winningOutcomeIndices?: number[];
}

export interface BetPayoutResult {
  /** The amount paid to the user in tNGN. Always >= 0. */
  payoutTngn: number;
  /** True if floor binds (we paid the locked-floor minimum). */
  floorBound: boolean;
  /** True if parimutuel-with-vig binds (opposing money lifted upside). */
  upsideBound: boolean;
  /**
   * The locked floor that was honored regardless of which path bound.
   * For audit + display in admin forensic views.
   */
  floorPayoutTngn: number;
  /**
   * The parimutuel-with-vig path's payout (whether or not it bound).
   * For audit.
   */
  parimutuelWithVigTngn: number;
}

export interface VipCutResult {
  vipReferrerId: string;
  amountTngn: number;
  betId: string;
  basis: 'house_margin';
}

export interface LockedSettlementSummary {
  /** Total tNGN paid to winners. */
  totalWinnerPayouts: number;
  /** Total VIP rake share routed (deducted from house margin). */
  totalVipPayouts: number;
  /**
   * House P&L on this market. Positive = profit (reserve grows);
   * negative = loss (reserve shrinks).
   *
   * Formula:
   *   pnl = sum(all_net_stakes) - sum(winner_payouts) - sum(vip_payouts)
   *
   * The seed pool is the house's own capital that opened the market.
   * It enters the effective pool used to derive locked odds but doesn't
   * appear in this P&L formula directly — what matters is that the
   * money users put in (net_stakes) minus the money paid out (to
   * winners + VIPs) IS the house's net position from this market. If
   * winners outpace stakes, the gap comes from the seed (and ultimately
   * the reserve).
   */
  houseProfitTngn: number;
  /** Per-bet outcomes, in input order. */
  perBet: Array<{
    betId: string;
    userId: string;
    won: boolean;
    payoutTngn: number;
    floorBound?: boolean;
    upsideBound?: boolean;
  }>;
  /** VIP cuts for downstream credit_user + vip_referral_earnings inserts. */
  vipCuts: VipCutResult[];
  /** True if no losing bets existed — admin should mark voided + refund. */
  isOneSided: boolean;
}

// ─── Per-bet payout ──────────────────────────────────────────────────

/**
 * Compute the tNGN payout for a single winning bet under locked odds.
 *
 *   payout = MAX(floor, parimutuel-with-vig)
 *
 * The user is paid AT LEAST the locked floor. If opposing money piled
 * in after their stake, the pool-implied payout (using their original
 * vig) can exceed the floor, and we pay the bigger number.
 *
 * Floor binds when:
 *   - Pool moved against the user (their side filled up further), OR
 *   - The opposing side never developed (first-mover case).
 *
 * Upside binds when opposing real money grew after stake placement.
 *
 * Net stake is treated as already-included in the pool (it was added
 * when the bet was placed; pool_by_outcome reflects post-stake state).
 * Do NOT double-add it here.
 */
export function calculateLockedPayout(
  bet: Pick<LockedBet, 'netStakeTngn' | 'lockedOdds' | 'vigAtStakePct' | 'outcomeIndex'>,
  resolution: MarketResolution,
): BetPayoutResult {
  const { netStakeTngn, lockedOdds, vigAtStakePct, outcomeIndex } = bet;

  // 1. Floor payout — the guaranteed minimum.
  const floorPayoutTngn = Math.round(netStakeTngn * lockedOdds);

  // 2. Parimutuel-with-vig — what the user gets if we apply their
  //    original vig to the FINAL pool composition.
  //
  //    Pool extraction is defensive against null/negative entries; we
  //    do not crash on transient bad reads.
  const effective = resolution.seedPool.map((s, i) => {
    const safeSeed = Number.isFinite(s) && s > 0 ? s : 0;
    const real = resolution.realPool[i];
    const safeReal = Number.isFinite(real) && real > 0 ? real : 0;
    return safeSeed + safeReal;
  });
  const total = effective.reduce((a, b) => a + b, 0);
  const poolChosen = effective[outcomeIndex] || 0;

  let parimutuelWithVigTngn = 0;
  if (poolChosen > 0 && total > 0 && Number.isFinite(vigAtStakePct)) {
    // user's share of (post-vig) total pool, scaled by their net stake
    const share = netStakeTngn / poolChosen;
    const rawPayout = share * total;
    parimutuelWithVigTngn = Math.round(rawPayout / (1 + vigAtStakePct));
  }

  // 3. Pay MAX. Never less than floor — that's the honest contract.
  const payoutTngn = Math.max(floorPayoutTngn, parimutuelWithVigTngn);
  const floorBound = payoutTngn === floorPayoutTngn && payoutTngn >= parimutuelWithVigTngn;
  const upsideBound = payoutTngn > floorPayoutTngn;

  return {
    payoutTngn,
    floorBound,
    upsideBound,
    floorPayoutTngn,
    parimutuelWithVigTngn,
  };
}

// ─── Per-bet VIP cut ─────────────────────────────────────────────────

/**
 * VIP rake-share for a LOSING bet under locked odds.
 *
 * Under parimutuel the VIP got a fraction of the pool rake. Under
 * locked odds there is no pool rake (the vig is baked into the odds),
 * so the VIP share is computed against the HOUSE MARGIN this bet
 * generated:
 *
 *   bet's contribution to house margin ≈ net_stake × vig_at_stake
 *
 * VIP cut = that × (rake_share_pct / 100).
 *
 * For a winning bet, the user got paid — no margin to split — so VIPs
 * earn only on their referees' LOSSES, same as the parimutuel model.
 */
export function calculateLockedVipCut(
  bet: Pick<LockedBet, 'id' | 'netStakeTngn' | 'vigAtStakePct' | 'vipRakeSharePct' | 'vipReferrerId'>,
): VipCutResult | null {
  const sharePct = bet.vipRakeSharePct ?? 0;
  if (!bet.vipReferrerId || sharePct <= 0) return null;
  if (!Number.isFinite(bet.vigAtStakePct) || bet.vigAtStakePct <= 0) return null;

  const margin = bet.netStakeTngn * bet.vigAtStakePct;
  const amountTngn = Math.round(margin * (sharePct / 100));
  if (amountTngn <= 0) return null;

  return {
    vipReferrerId: bet.vipReferrerId,
    amountTngn,
    betId: bet.id,
    basis: 'house_margin',
  };
}

// ─── Whole-market settlement ────────────────────────────────────────

/**
 * Settle every bet on a locked-odds market in one pass and return the
 * deltas the caller needs to apply (credit_user, update bet status,
 * update house_reserve, log vip earnings).
 *
 * This function is PURE. The caller is responsible for the atomic
 * application of the deltas.
 *
 * Voiding decision: a locked-odds market with bets only on the winning
 * side (no losing pool) is paid at the locked floor honestly — the
 * house wears the bump from reserve. This is the "first mover keeps
 * the floor" promise. ONE-SIDED with the wrong side winning is a void
 * scenario (no one to pay), so we surface it and the caller refunds.
 */
export function settleLockedMarket(
  bets: LockedBet[],
  resolution: MarketResolution,
): LockedSettlementSummary {
  const winningSet = new Set(
    resolution.winningOutcomeIndices?.length ? resolution.winningOutcomeIndices : [resolution.winningOutcomeIndex],
  );
  const winningBets = bets.filter(b => winningSet.has(b.outcomeIndex));
  const losingBets  = bets.filter(b => !winningSet.has(b.outcomeIndex));

  const isOneSided = losingBets.length > 0 && winningBets.length === 0;

  let totalWinnerPayouts = 0;
  let totalVipPayouts = 0;
  const perBet: LockedSettlementSummary['perBet'] = [];
  const vipCuts: VipCutResult[] = [];

  for (const bet of winningBets) {
    const r = calculateLockedPayout(bet, resolution);
    totalWinnerPayouts += r.payoutTngn;
    perBet.push({
      betId: bet.id,
      userId: bet.userId,
      won: true,
      payoutTngn: r.payoutTngn,
      floorBound: r.floorBound,
      upsideBound: r.upsideBound,
    });
  }

  for (const bet of losingBets) {
    perBet.push({
      betId: bet.id,
      userId: bet.userId,
      won: false,
      payoutTngn: 0,
    });

    const vipCut = calculateLockedVipCut(bet);
    if (vipCut) {
      vipCuts.push(vipCut);
      totalVipPayouts += vipCut.amountTngn;
    }
  }

  // House P&L. Formula derivation in the docstring on
  // LockedSettlementSummary.houseProfitTngn.
  const totalNetStakes = bets.reduce((a, b) => a + b.netStakeTngn, 0);
  const houseProfitTngn = totalNetStakes - totalWinnerPayouts - totalVipPayouts;

  return {
    totalWinnerPayouts,
    totalVipPayouts,
    houseProfitTngn,
    perBet,
    vipCuts,
    isOneSided,
  };
}

// ─── Convenience: derive net stake from gross ───────────────────────

/** Net stake formula. Exported so callers can verify rounded values match. */
export function netStakeFromGross(grossStakeTngn: number): number {
  return grossStakeTngn * (1 - ENTRY_RAKE_PCT);
}
