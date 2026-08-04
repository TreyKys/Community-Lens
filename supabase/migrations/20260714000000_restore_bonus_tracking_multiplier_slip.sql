-- CRITICAL FIX: restore bonus tracking in place_multiplier_slip.
--
-- Migration 20260710010000 (the leg-pricing monotonicity fix) redefined
-- place_multiplier_slip based on the ORIGINAL 20260621010000 body — not
-- noticing that 20260630200000 had ALSO redefined it in between to add:
--   1. the in-transaction bonus expiry check (expired bonus zeroed
--      before it can fund a stake), and
--   2. computing + storing multiplier_slips.bonus_proportion, which
--      settle_multiplier_for_market uses to split winnings between
--      bonus_balance and tngn_balance (bonus_winnings_split) and to
--      route void refunds back to the right wallet.
--
-- Because migrations apply in timestamp order, 20260710010000 silently
-- stripped both: every slip placed after it has bonus_proportion NULL,
-- which settlement COALESCEs to 0 — i.e. winnings and refunds paid 100%
-- to withdrawable cash even for fully bonus-funded slips, and expired
-- bonus stays spendable. No funds are lost or stuck, but the bonus
-- anti-laundering accounting is bypassed.
--
-- This migration is the union of both prior definitions:
--   * bonus expiry check + bonus_proportion (from 20260630200000)
--   * fixed ₦100 leg-pricing reference stake, so bigger stakes can never
--     pay less (from 20260710010000)
--   * direct-clamp payout-cap math, no grid-floor wobble near the ₦200k
--     cap (from 20260710010000)
--
-- Slips already placed with a NULL bonus_proportion cannot be
-- reconstructed (the pre-stake wallet balances weren't recorded); they
-- settle under the grandfathered all-cash rule, same as slips predating
-- the bonus feature.

CREATE OR REPLACE FUNCTION public.place_multiplier_slip(
  p_user_id     uuid,
  p_slip_stake  numeric,
  p_legs        jsonb
)
RETURNS TABLE (
  slip_id                  uuid,
  combined_odds            numeric,
  effective_combined_odds  numeric,
  net_slip_stake           numeric,
  payout_tngn              numeric,
  tier                     smallint,
  boosts_remaining         integer,
  new_tngn_balance         numeric,
  new_bonus_balance        numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_entry_rake_pct   constant numeric := 0.015;
  c_min_slip_stake   constant numeric := 100;
  c_tier2_min        constant numeric := 500;
  c_min_legs         constant integer := 2;
  c_max_legs_t1      constant integer := 5;
  c_max_legs_t2      constant integer := 10;
  c_min_leg_odds     constant numeric := 1.20;
  c_min_combined     constant numeric := 3.0;
  c_max_payout       constant numeric := 200000;
  -- Fixed notional used ONLY to price each leg's odds — a parlay leg's
  -- stake never enters its market's pool, so its odds must not depend on
  -- slip size (see 20260710010000). MUST match
  -- MULT_LEG_PRICING_REFERENCE_STAKE in lib/multiplier.ts.
  c_leg_pricing_reference_stake constant numeric := 100;

  v_real             numeric;
  v_bonus            numeric;
  v_bonus_expires_at timestamptz;
  v_boost_balance    integer;
  v_tier             smallint;
  v_max_legs         integer;
  v_leg_count        integer;
  v_deployable       numeric;
  v_floor            numeric;
  v_combined         numeric := 1;
  v_market_ids       bigint[] := ARRAY[]::bigint[];
  v_leg              jsonb;
  v_market_id        bigint;
  v_outcome_index    integer;
  v_market           record;
  v_num_outcomes     integer;
  v_seed_pool        numeric[];
  v_real_pool        numeric[];
  v_calc             record;
  v_entry_rake       numeric;
  v_net_slip_stake   numeric;
  v_effective_comb   numeric;
  v_payout           numeric;
  v_new_real         numeric;
  v_new_bonus        numeric;
  v_slip_id          uuid;
  v_bonus_proportion numeric;
  i                  integer;
  j                  integer;
BEGIN
  IF p_user_id IS NULL OR p_slip_stake IS NULL OR p_legs IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF p_slip_stake < c_min_slip_stake THEN
    RAISE EXCEPTION 'stake_below_min' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_legs) <> 'array' THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;

  v_leg_count := jsonb_array_length(p_legs);
  v_tier := CASE WHEN p_slip_stake < c_tier2_min THEN 1 ELSE 2 END;
  v_max_legs := CASE WHEN v_tier = 1 THEN c_max_legs_t1 ELSE c_max_legs_t2 END;

  IF v_leg_count < c_min_legs THEN
    RAISE EXCEPTION 'too_few_legs' USING ERRCODE = 'P0001';
  END IF;
  IF v_leg_count > v_max_legs THEN
    RAISE EXCEPTION 'too_many_legs' USING ERRCODE = 'P0001';
  END IF;

  SELECT tngn_balance, bonus_balance, bonus_expires_at
    INTO v_real, v_bonus, v_bonus_expires_at
  FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_real  := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);

  -- Expire stale bonus in-transaction before computing available balance.
  IF v_bonus > 0 AND v_bonus_expires_at IS NOT NULL AND v_bonus_expires_at <= now() THEN
    v_bonus := 0;
    UPDATE public.users SET bonus_balance = 0, bonus_expires_at = NULL WHERE id = p_user_id;
  END IF;

  IF v_real + v_bonus < p_slip_stake THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.ensure_boost_wallet(p_user_id);
  SELECT balance INTO v_boost_balance FROM public.boost_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF COALESCE(v_boost_balance, 0) < 1 THEN
    RAISE EXCEPTION 'no_boosts' USING ERRCODE = 'P0001';
  END IF;

  SELECT deployable_tngn, floor_tngn INTO v_deployable, v_floor FROM public.reserve_health;
  IF v_deployable IS NULL OR v_floor IS NULL THEN
    RAISE EXCEPTION 'reserve_unavailable' USING ERRCODE = 'P0003';
  END IF;

  v_entry_rake := round(p_slip_stake * c_entry_rake_pct, 4);
  v_net_slip_stake := p_slip_stake - v_entry_rake;

  -- Balance deduction — real first, then bonus — compute proportion now
  -- (using pre-deduction v_real) before the slip shell INSERT so the
  -- stored bonus_proportion reflects what actually funded this slip.
  IF v_real >= p_slip_stake THEN
    v_new_real         := v_real - p_slip_stake;
    v_new_bonus        := v_bonus;
    v_bonus_proportion := 0.0;
  ELSE
    v_new_real         := 0;
    v_new_bonus        := v_bonus - (p_slip_stake - v_real);
    v_bonus_proportion := (p_slip_stake - v_real) / p_slip_stake;
  END IF;

  v_slip_id := gen_random_uuid();
  INSERT INTO public.multiplier_slips (
    id, user_id, slip_stake_tngn, net_slip_stake_tngn, entry_rake_tngn,
    combined_odds, effective_combined_odds, payout_tngn, tier,
    legs_total, legs_resolved, legs_won, status, bonus_proportion
  ) VALUES (
    v_slip_id, p_user_id, p_slip_stake, v_net_slip_stake, v_entry_rake,
    1, 1, 0, v_tier,
    v_leg_count, 0, 0, 'active', v_bonus_proportion
  );

  FOR i IN 0..v_leg_count - 1 LOOP
    v_leg := p_legs -> i;
    v_market_id := (v_leg ->> 'market_id')::bigint;
    v_outcome_index := (v_leg ->> 'outcome_index')::integer;

    IF v_market_id IS NULL OR v_outcome_index IS NULL OR v_outcome_index < 0 THEN
      RAISE EXCEPTION 'invalid_leg' USING ERRCODE = 'P0001';
    END IF;

    IF v_market_id = ANY(v_market_ids) THEN
      RAISE EXCEPTION 'duplicate_event' USING ERRCODE = 'P0001';
    END IF;
    v_market_ids := array_append(v_market_ids, v_market_id);

    SELECT id, status, closes_at, options, pool_by_outcome,
           seed_pool, category, vig_pct, is_locked_odds, is_paused
      INTO v_market
    FROM public.markets WHERE id = v_market_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'market_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT COALESCE(v_market.is_locked_odds, false) THEN
      RAISE EXCEPTION 'leg_not_locked_odds' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(v_market.is_paused, false) THEN
      RAISE EXCEPTION 'leg_paused' USING ERRCODE = 'P0001';
    END IF;
    IF v_market.status <> 'open' THEN
      RAISE EXCEPTION 'leg_not_open' USING ERRCODE = 'P0001';
    END IF;
    IF v_market.closes_at <= now() THEN
      RAISE EXCEPTION 'leg_closed' USING ERRCODE = 'P0001';
    END IF;

    v_num_outcomes := jsonb_array_length(v_market.options);
    IF v_outcome_index >= v_num_outcomes THEN
      RAISE EXCEPTION 'invalid_leg' USING ERRCODE = 'P0001';
    END IF;

    v_seed_pool := ARRAY[]::numeric[];
    v_real_pool := ARRAY[]::numeric[];
    FOR j IN 0..v_num_outcomes - 1 LOOP
      v_seed_pool := array_append(v_seed_pool, COALESCE((v_market.seed_pool ->> j::text)::numeric, 0));
      v_real_pool := array_append(v_real_pool, COALESCE((v_market.pool_by_outcome ->> j::text)::numeric, 0));
    END LOOP;

    -- Price the leg at the FIXED reference stake, never the real slip
    -- stake — see 20260710010000 for why (payout monotonicity).
    SELECT * INTO v_calc
    FROM public.calculate_locked_odds_sql(
      v_seed_pool, v_real_pool, v_market.category, v_market.vig_pct,
      c_leg_pricing_reference_stake, v_outcome_index, NULL, v_deployable, v_floor
    );

    IF v_calc.locked_odds < c_min_leg_odds THEN
      RAISE EXCEPTION 'leg_below_min_odds' USING ERRCODE = 'P0001';
    END IF;

    v_combined := v_combined * v_calc.locked_odds;

    INSERT INTO public.multiplier_legs (
      slip_id, market_id, outcome_index, locked_odds, vig_at_stake_pct, status
    ) VALUES (
      v_slip_id, v_market_id, v_outcome_index, v_calc.locked_odds, v_calc.vig_applied, 'active'
    );
  END LOOP;

  v_combined := round(v_combined, 2);
  IF v_combined < c_min_combined THEN
    RAISE EXCEPTION 'combined_below_min' USING ERRCODE = 'P0001';
  END IF;

  -- Payout is a direct clamp on the uncapped amount (LEAST already
  -- guarantees the ceiling); effective_comb is derived FROM the capped
  -- payout so the stored multiplier always matches what's actually paid.
  -- See 20260710010000 for the grid-floor wobble this replaced.
  v_payout := LEAST(c_max_payout, round(v_net_slip_stake * v_combined));
  IF v_net_slip_stake > 0 AND v_net_slip_stake * v_combined > c_max_payout THEN
    v_effective_comb := round(v_payout / v_net_slip_stake, 2);
  ELSE
    v_effective_comb := v_combined;
  END IF;

  UPDATE public.users
    SET tngn_balance = v_new_real,
        bonus_balance = GREATEST(v_new_bonus, 0)
  WHERE id = p_user_id;

  v_boost_balance := v_boost_balance - 1;
  UPDATE public.boost_wallet
    SET balance = v_boost_balance,
        lifetime_spent = lifetime_spent + 1,
        updated_at = now()
  WHERE user_id = p_user_id;
  INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
  VALUES (p_user_id, -1, 'slip_spend', v_slip_id, v_boost_balance);

  UPDATE public.multiplier_slips
    SET combined_odds = v_combined,
        effective_combined_odds = v_effective_comb,
        payout_tngn = v_payout
  WHERE id = v_slip_id;

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, created_at)
  VALUES ('entry_rake', v_entry_rake, p_user_id, now());

  UPDATE public.users SET points = COALESCE(points, 0) + GREATEST(1, floor(p_slip_stake / 250)::int)
  WHERE id = p_user_id;

  RETURN QUERY SELECT
    v_slip_id, v_combined, v_effective_comb, v_net_slip_stake, v_payout,
    v_tier, v_boost_balance, v_new_real, GREATEST(v_new_bonus, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.place_multiplier_slip(uuid, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_multiplier_slip(uuid, numeric, jsonb) TO service_role;

COMMENT ON FUNCTION public.place_multiplier_slip IS
  'Atomic parlay placement. Union of 20260630200000 (bonus expiry check + bonus_proportion recording, consumed by settle_multiplier_for_market''s bonus_winnings_split) and 20260710010000 (fixed ₦100 leg-pricing reference stake + direct-clamp payout cap). See migration 20260714000000 for why these had to be re-merged.';

NOTIFY pgrst, 'reload schema';
