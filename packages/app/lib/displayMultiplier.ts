// Friendly display floor for the parimutuel first-mover / void-refund
// states. Single source of truth, sharing constants with the locked-
// odds engine (lib/lockedOdds.ts) so the same tier boundaries apply
// across both engines — a user moving between a parimutuel and a
// locked-odds market sees the same floor mechanics.
//
// THE PROMISE
// ───────────
// A user staking ₦S on a parimutuel market sees a minimum projected
// payout of `displayFloorPayout(S).payout`. The backend honours this:
// if the market voids (no opposing prediction by close, no winner, no
// loser) every refunded bet is credited at MAX(net_stake, floor_payout)
// instead of plain net_stake. So the display is a real guarantee, not
// a decorative number.
//
// Floor mechanics mirror calculateLockedOdds:
//   - Stake < ₦500 → Tier 1 (1.03× floor)
//   - Stake ≥ ₦500 → Tier 2 (1.02× floor)
// Plus a boundary-monotonic adjustment so a ₦499 stake (Tier 1) never
// shows a higher floor than ₦500 (Tier 2) — the bait-and-switch the
// floor mechanic exists to prevent in the first place.

import { TIER1_FLOOR, TIER2_FLOOR, TIER2_MIN_STAKE, ENTRY_RAKE_PCT } from './lockedOdds';

export { TIER1_FLOOR, TIER2_FLOOR, TIER2_MIN_STAKE, ENTRY_RAKE_PCT };

export interface FloorPayout {
  /** The tier floor multiplier used (after boundary monotonicity). */
  multiplier: number;
  /** Rounded payout the user is shown / paid on void refund. */
  payout: number;
}

/**
 * Compute the friendly floor payout for a prospective stake. Pure,
 * deterministic, no I/O. Same shape and rules as the locked-odds floor
 * so display + settlement + audit all agree.
 */
export function displayFloorPayout(stake: number): FloorPayout {
  if (!Number.isFinite(stake) || stake <= 0) {
    return { multiplier: 1, payout: 0 };
  }
  const netStake = stake * (1 - ENTRY_RAKE_PCT);
  const tier = stake < TIER2_MIN_STAKE ? 1 : 2;
  const naive = tier === 1 ? TIER1_FLOOR : TIER2_FLOOR;
  // Boundary-monotonic adjustment, identical to lockedOdds.ts:261. At
  // stakes well above ₦500 this collapses to TIER2_FLOOR; only the
  // immediate post-boundary region is lifted.
  const tierFloor = tier === 2
    ? Math.max(
        TIER2_FLOOR,
        (TIER2_MIN_STAKE * (1 - ENTRY_RAKE_PCT) * TIER1_FLOOR) / netStake,
      )
    : naive;
  return {
    multiplier: tierFloor,
    payout: Math.round(netStake * tierFloor),
  };
}
