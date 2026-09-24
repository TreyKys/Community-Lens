-- Fix two CHECK constraints missed when the vig ceiling was raised.
--
-- 20260916000000 raised MAX_VIG from 0.15 to 0.55 in three places: the
-- markets table's own vig_pct constraint, market_templates', and
-- calculate_locked_odds_sql's c_max_vig. It missed two more constraints
-- that store the vig a bet or leg actually PRICED at, not a market's
-- configured vig_pct:
--
--   user_bets.vig_at_stake_pct       (20260620170000)
--   multiplier_legs.vig_at_stake_pct (20260621000000)
--
-- Both were still capped at <= 0.15. calculate_locked_odds_sql can now
-- legitimately return anything up to 0.55 (category vig + surcharges,
-- clamped there) — so any bet or Multiplier leg on a market whose priced
-- vig landed above 0.15 hit an unhandled 23514 constraint violation with
-- no matching case in mapSlipError (place_bet_locked has the equivalent
-- gap), surfacing as a raw 500 instead of a real business-rule rejection.
--
-- Confirmed against a local throwaway DB, not just reasoned about:
-- inserted real production markets currently sitting at vig_pct 0.47/0.53
-- (both legitimately opened under the raised ceiling) and reproduced this
-- exact constraint violation via place_multiplier_slip before applying
-- this fix, then confirmed it clears after.

ALTER TABLE public.user_bets
  DROP CONSTRAINT IF EXISTS user_bets_vig_at_stake_pct_check,
  ADD CONSTRAINT user_bets_vig_at_stake_pct_check
    CHECK (vig_at_stake_pct IS NULL OR (vig_at_stake_pct >= 0.04 AND vig_at_stake_pct <= 0.55));

ALTER TABLE public.multiplier_legs
  DROP CONSTRAINT IF EXISTS multiplier_legs_vig_at_stake_pct_check,
  ADD CONSTRAINT multiplier_legs_vig_at_stake_pct_check
    CHECK (vig_at_stake_pct >= 0.04 AND vig_at_stake_pct <= 0.55);
