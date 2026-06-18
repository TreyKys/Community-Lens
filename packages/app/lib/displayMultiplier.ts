// lib/displayMultiplier.ts
//
// DISPLAY-ONLY "friendly odds" layer. This is purely cosmetic — it is
// never sent to the server, never stored on a bet, and never affects a
// real settlement. The server (place_bet RPC + /api/markets/resolve)
// remains the single source of truth for every naira that actually
// moves. Treat everything here as presentation, not money.
//
// WHY THIS EXISTS
// A "first mover" — someone staking before anyone has taken the opposing
// side — sees a real parimutuel projection that is either a void warning
// or a sub-1.0x number (≈0.89x on an empty market, after the silent
// rake). That kills the will to stake, and means the house has to seed
// every market itself to avoid an empty-pool cold start.
//
// Instead we show a small optimistic FLOOR — stake × a tier multiplier —
// framed honestly as a starting point that grows as the opposing pool
// fills, whose downside is "your stake is returned" (which is exactly
// what a void refund does today). Once real opposing money exists, we
// stop using the floor and show the true parimutuel projection.
//
// TIERS ARE INVISIBLE TO THE USER (product rule: users never see the
// tier seam). The boundary is the existing ≥₦500 jackpot / Tier-2
// threshold already baked into place_bet (is_jackpot_eligible). Keeping
// the boundary here means this is forward-compatible with the real
// two-tier engine when it lands: only the tier-resolution input changes,
// the call sites don't.

export const TIER2_MIN_STAKE = 500;
export const TIER1_DISPLAY_MULT = 1.03;
export const TIER2_DISPLAY_MULT = 1.02;

/** The cosmetic multiplier for a given stake. Silent — no tier is ever
 *  labelled in the UI. */
export function displayTierMultiplier(stake: number): number {
  return stake >= TIER2_MIN_STAKE ? TIER2_DISPLAY_MULT : TIER1_DISPLAY_MULT;
}

/**
 * Monotonic display FLOOR in naira. Guarantees that increasing your
 * stake never shows a SMALLER projected return.
 *
 * Without the clamp, crossing the ₦500 boundary flips 1.03x → 1.02x, so
 * ₦499 would show ₦513.97 while ₦500 shows ₦510 — the projected payout
 * would visibly DROP as the user bets more. That reads as a bug and
 * erodes trust at the exact moment we're trying to build it. The clamp
 * holds the ≥₦500 floor at no less than the boundary's Tier-1 value
 * until the Tier-2 curve overtakes it.
 */
export function displayFloorPayout(stake: number): number {
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (stake < TIER2_MIN_STAKE) return stake * TIER1_DISPLAY_MULT;
  return Math.max(stake * TIER2_DISPLAY_MULT, TIER2_MIN_STAKE * TIER1_DISPLAY_MULT);
}
