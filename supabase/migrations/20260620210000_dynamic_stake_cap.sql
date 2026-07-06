-- Phase 6: dynamic stake cap inside place_bet_locked.
--
-- Replaces the previous fixed-cap check with a reserve-tied schedule.
-- Below the ₦30k floor, place_bet_locked rejects with 'tier2_paused'
-- so the API route can route to parimutuel ("silent fallback"). Above
-- the floor, the cap shrinks as deployable approaches it:
--
--   deployable > ₦80k   → cap ₦5,000
--   ₦50k–₦80k           → cap ₦3,000
--   ₦30k–₦50k           → cap ₦1,500
--   < ₦30k              → Tier 2 paused (silent fallback to parimutuel)
--
-- The cap is enforced only for Tier 2 stakes (>= ₦500). Tier 1 stakes
-- (< ₦500) always proceed if the market accepts them. Tier 1 has its
-- own implicit cap — Tier 2 minimum.
--
-- Per-market liability ceiling stays at ₦40k/side; that check is
-- unchanged from Phase 3b.

CREATE OR REPLACE FUNCTION public.place_bet_locked(
  p_user_id        uuid,
  p_market_id      bigint,
  p_outcome_index  integer,
  p_stake_tngn     numeric
)
RETURNS TABLE (
  bet_id              uuid,
  locked_odds         numeric,
  net_stake           numeric,
  entry_rake          numeric,
  vig_at_stake_pct    numeric,
  tier                smallint,
  floor_payout        numeric,
  upper_payout        numeric,
  new_tngn_balance    numeric,
  new_bonus_balance   numeric,
  is_jackpot_eligible boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Constants — match lib/lockedOdds.ts / calculate_locked_odds_sql.
  c_entry_rake_pct           constant numeric := 0.015;
  c_min_stake                constant numeric := 100;
  c_tier2_min_stake          constant numeric := 500;
  c_jackpot_min              constant numeric := 500;
  c_points_per_naira_wagered constant numeric := 1.0 / 250.0;
  c_per_side_liability_cap   constant numeric := 40000;

  -- Dynamic-cap thresholds. Read alongside Phase 0 spec § 8.
  c_health_pause_threshold   constant numeric := 0;        -- deployable <= 0 (at or below floor)
  c_health_low_threshold     constant numeric := 50000;    -- deployable < 50k → cap 1500
  c_health_mid_threshold     constant numeric := 80000;    -- deployable < 80k → cap 3000
  c_cap_max                  constant numeric := 5000;
  c_cap_mid                  constant numeric := 3000;
  c_cap_low                  constant numeric := 1500;

  v_market                   record;
  v_num_outcomes             integer;
  v_seed_pool                numeric[];
  v_real_pool                numeric[];
  v_real                     numeric;
  v_bonus                    numeric;
  v_accuracy_tier            text;
  v_deployable               numeric;
  v_floor                    numeric;
  v_calc                     record;
  v_entry_rake               numeric;
  v_net_stake                numeric;
  v_new_real                 numeric;
  v_new_bonus                numeric;
  v_bet_id                   uuid;
  v_jackpot                  boolean;
  v_existing_liability       record;
  v_existing_exposure        jsonb;
  v_new_outcome_exposure     numeric;
  v_new_exposure             jsonb;
  v_new_worst_case           numeric;
  v_other_exposure           numeric;
  v_pool_key                 text;
  v_current_pool             numeric;
  v_points_to_award          integer;
  v_dynamic_cap              numeric;
  i                          integer;
BEGIN
  -- Same input validation as Phase 3b.
  IF p_user_id IS NULL OR p_market_id IS NULL
     OR p_outcome_index IS NULL OR p_stake_tngn IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF p_stake_tngn < c_min_stake THEN
    RAISE EXCEPTION 'stake_below_minimum' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome_index < 0 THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, status, closes_at, options, total_pool, pool_by_outcome,
         seed_pool, category, vig_pct, is_locked_odds, is_paused
    INTO v_market
  FROM public.markets WHERE id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE(v_market.is_locked_odds, false) THEN
    RAISE EXCEPTION 'market_not_locked_odds' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(v_market.is_paused, false) THEN
    RAISE EXCEPTION 'market_paused' USING ERRCODE = 'P0001';
  END IF;
  IF v_market.status <> 'open' THEN
    RAISE EXCEPTION 'market_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF v_market.closes_at <= now() THEN
    RAISE EXCEPTION 'market_closed' USING ERRCODE = 'P0001';
  END IF;

  v_num_outcomes := jsonb_array_length(v_market.options);
  IF p_outcome_index >= v_num_outcomes THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = 'P0001';
  END IF;

  SELECT tngn_balance, bonus_balance
    INTO v_real, v_bonus
  FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_real  := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);
  IF v_real + v_bonus < p_stake_tngn THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  v_accuracy_tier := NULL;

  SELECT deployable_tngn, floor_tngn
    INTO v_deployable, v_floor
  FROM public.reserve_health;
  IF v_deployable IS NULL OR v_floor IS NULL THEN
    RAISE EXCEPTION 'reserve_unavailable' USING ERRCODE = 'P0003';
  END IF;

  -- ── Dynamic stake-cap check (Tier 2 only) ───────────────────────
  -- Tier 1 stakes (< 500) skip this. Tier 2 stakes are capped to the
  -- amount the current reserve can responsibly accept.
  IF p_stake_tngn >= c_tier2_min_stake THEN
    IF v_deployable <= c_health_pause_threshold THEN
      -- At or below floor → Tier 2 paused.
      INSERT INTO public.tier_routing_log (
        user_id, market_id, requested_stake, intended_tier, actual_tier, reason
      ) VALUES (
        p_user_id, p_market_id, p_stake_tngn, 2, 1, 'tier2_paused_reserve_floor'
      );
      RAISE EXCEPTION 'tier2_paused' USING ERRCODE = 'P0001';
    ELSIF v_deployable < c_health_low_threshold THEN
      v_dynamic_cap := c_cap_low;
    ELSIF v_deployable < c_health_mid_threshold THEN
      v_dynamic_cap := c_cap_mid;
    ELSE
      v_dynamic_cap := c_cap_max;
    END IF;

    IF p_stake_tngn > v_dynamic_cap THEN
      INSERT INTO public.tier_routing_log (
        user_id, market_id, requested_stake, intended_tier, actual_tier, reason
      ) VALUES (
        p_user_id, p_market_id, p_stake_tngn, 2, 2, 'stake_above_dynamic_cap'
      );
      RAISE EXCEPTION 'stake_above_dynamic_cap_%', v_dynamic_cap USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── Pool extraction (unchanged from Phase 3b) ───────────────────
  v_seed_pool := ARRAY[]::numeric[];
  v_real_pool := ARRAY[]::numeric[];
  FOR i IN 0..v_num_outcomes - 1 LOOP
    v_seed_pool := array_append(
      v_seed_pool,
      COALESCE((v_market.seed_pool ->> i::text)::numeric, 0)
    );
    v_real_pool := array_append(
      v_real_pool,
      COALESCE((v_market.pool_by_outcome ->> i::text)::numeric, 0)
    );
  END LOOP;

  SELECT *
    INTO v_calc
  FROM public.calculate_locked_odds_sql(
    v_seed_pool,
    v_real_pool,
    v_market.category,
    v_market.vig_pct,
    p_stake_tngn,
    p_outcome_index,
    v_accuracy_tier,
    v_deployable,
    v_floor
  );

  -- Per-market liability ceiling (unchanged from Phase 3b).
  SELECT exposure_by_outcome, worst_case_tngn
    INTO v_existing_liability
  FROM public.market_liability WHERE market_id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN
    v_existing_exposure := '{}'::jsonb;
  ELSE
    v_existing_exposure := v_existing_liability.exposure_by_outcome;
  END IF;

  v_new_outcome_exposure :=
    COALESCE((v_existing_exposure ->> p_outcome_index::text)::numeric, 0)
    + (v_calc.net_stake * v_calc.locked_odds);

  IF v_new_outcome_exposure > c_per_side_liability_cap THEN
    INSERT INTO public.tier_routing_log (
      user_id, market_id, requested_stake,
      intended_tier, actual_tier, reason
    ) VALUES (
      p_user_id, p_market_id, p_stake_tngn,
      v_calc.tier, v_calc.tier, 'liability_ceiling_breach'
    );
    RAISE EXCEPTION 'liability_ceiling_breach' USING ERRCODE = 'P0001';
  END IF;

  -- ── Remaining settlement (unchanged from Phase 3b) ──────────────
  v_entry_rake := round(p_stake_tngn * c_entry_rake_pct, 4);
  v_net_stake  := v_calc.net_stake;
  v_jackpot    := p_stake_tngn >= c_jackpot_min;

  IF v_real >= p_stake_tngn THEN
    v_new_real  := v_real - p_stake_tngn;
    v_new_bonus := v_bonus;
  ELSE
    v_new_real  := 0;
    v_new_bonus := v_bonus - (p_stake_tngn - v_real);
  END IF;

  UPDATE public.users
    SET tngn_balance  = v_new_real,
        bonus_balance = GREATEST(v_new_bonus, 0)
  WHERE id = p_user_id;

  INSERT INTO public.user_bets (
    user_id, market_id, outcome_index,
    stake_tngn, net_stake_tngn, entry_rake_tngn,
    is_jackpot_eligible, status, placed_at,
    locked_odds, vig_at_stake_pct, tier, bet_kind
  ) VALUES (
    p_user_id, p_market_id, p_outcome_index,
    p_stake_tngn, v_net_stake, v_entry_rake,
    v_jackpot, 'active', now(),
    v_calc.locked_odds, v_calc.vig_applied, v_calc.tier, 'single'
  ) RETURNING id INTO v_bet_id;

  v_pool_key := p_outcome_index::text;
  v_current_pool := COALESCE((v_market.pool_by_outcome ->> v_pool_key)::numeric, 0);

  UPDATE public.markets
    SET total_pool      = COALESCE(total_pool, 0) + v_net_stake,
        pool_by_outcome = pool_by_outcome
          || jsonb_build_object(v_pool_key, v_current_pool + v_net_stake)
  WHERE id = p_market_id;

  v_new_exposure := COALESCE(v_existing_exposure, '{}'::jsonb)
    || jsonb_build_object(p_outcome_index::text, v_new_outcome_exposure);

  v_new_worst_case := v_new_outcome_exposure;
  FOR i IN 0..v_num_outcomes - 1 LOOP
    IF i <> p_outcome_index THEN
      v_other_exposure := COALESCE((v_new_exposure ->> i::text)::numeric, 0);
      IF v_other_exposure > v_new_worst_case THEN
        v_new_worst_case := v_other_exposure;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.market_liability (
    market_id, exposure_by_outcome, worst_case_tngn, updated_at
  ) VALUES (
    p_market_id, v_new_exposure, v_new_worst_case, now()
  )
  ON CONFLICT (market_id) DO UPDATE
    SET exposure_by_outcome = EXCLUDED.exposure_by_outcome,
        worst_case_tngn     = EXCLUDED.worst_case_tngn,
        updated_at          = EXCLUDED.updated_at;

  INSERT INTO public.treasury_log (
    type, amount_tngn, bet_id, user_id, market_id, created_at
  ) VALUES (
    'entry_rake', v_entry_rake, v_bet_id, p_user_id, p_market_id, now()
  );

  v_points_to_award := GREATEST(1, floor(p_stake_tngn * c_points_per_naira_wagered)::int);
  UPDATE public.users SET points = COALESCE(points, 0) + v_points_to_award WHERE id = p_user_id;
  INSERT INTO public.points_log (user_id, reason, points, related_bet_id)
  VALUES (p_user_id, 'bet_volume', v_points_to_award, v_bet_id);

  INSERT INTO public.tier_routing_log (
    user_id, market_id, requested_stake,
    intended_tier, actual_tier, reason
  ) VALUES (
    p_user_id, p_market_id, p_stake_tngn,
    v_calc.tier, v_calc.tier, 'accepted'
  );

  RETURN QUERY SELECT
    v_bet_id,
    v_calc.locked_odds,
    v_net_stake,
    v_entry_rake,
    v_calc.vig_applied,
    v_calc.tier,
    v_calc.floor_payout,
    v_calc.upper_payout,
    v_new_real,
    GREATEST(v_new_bonus, 0),
    v_jackpot;
END;
$$;

NOTIFY pgrst, 'reload schema';
