-- Bonus winnings split + 7-day expiry.
--
-- Rule: winnings from bonus-funded bets are split between cash and
-- bonus balance based on what fraction of the stake came from bonus:
--
--   ≥ 90 % bonus → 10 % withdrawable, 90 % back to bonus
--   ≥ 80 % bonus → 20 % withdrawable, 80 % back to bonus
--   ≥ 70 % bonus → 30 % withdrawable, 70 % back to bonus
--   <  70 % bonus → 100 % withdrawable (no split)
--
-- Expiry: any bonus credit expires 7 days after it is received.
-- Stale bonus is zeroed out at the moment of the next bet placement,
-- in the same transaction, so it is always consistent.
--
-- Implementation points:
--   1. users.bonus_expires_at   — when the current bonus balance expires
--   2. user_bets.bonus_proportion  — fraction of stake from bonus (0–1)
--   3. multiplier_slips.bonus_proportion — same for parlay slips
--   4. TRIGGER trg_users_bonus_expires — auto-sets bonus_expires_at
--      whenever bonus_balance increases (covers every credit path)
--   5. bonus_winnings_split()   — pure helper, used by settlement
--   6. place_bet, place_bet_locked, place_multiplier_slip — expire +
--      record bonus_proportion at placement
--   7. settle_multiplier_for_market — split payout on won/voided slips

-- ── 1. Schema additions ──────────────────────────────────────────────

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bonus_expires_at timestamptz;

ALTER TABLE public.user_bets
  ADD COLUMN IF NOT EXISTS bonus_proportion numeric
    NOT NULL DEFAULT 0
    CHECK (bonus_proportion >= 0 AND bonus_proportion <= 1);

ALTER TABLE public.multiplier_slips
  ADD COLUMN IF NOT EXISTS bonus_proportion numeric
    NOT NULL DEFAULT 0
    CHECK (bonus_proportion >= 0 AND bonus_proportion <= 1);

-- ── 2. Automatic expiry trigger ──────────────────────────────────────
-- Fires on every INSERT or UPDATE of users. When bonus_balance
-- increases, extends bonus_expires_at to at least 7 days from now.
-- Handles all credit paths (credit_user, claim_welcome_match,
-- redeem_referral_code, etc.) without touching each function.

CREATE OR REPLACE FUNCTION public.set_bonus_expires_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.bonus_balance, 0) > 0 THEN
      NEW.bonus_expires_at := now() + INTERVAL '7 days';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.bonus_balance, 0) > COALESCE(OLD.bonus_balance, 0) THEN
      -- Extend to GREATEST(current expiry, now + 7 days) so a shorter
      -- new credit doesn't shrink a longer existing window.
      NEW.bonus_expires_at := GREATEST(
        COALESCE(OLD.bonus_expires_at, now()),
        now() + INTERVAL '7 days'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_bonus_expires ON public.users;
CREATE TRIGGER trg_users_bonus_expires
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_bonus_expires_at();

-- ── 3. bonus_winnings_split helper ──────────────────────────────────
-- Pure function: given a payout and the bonus proportion that funded
-- the bet, returns how much goes to cash vs bonus balance.
-- bonus = payout - tngn ensures the total is exact with no drift.

CREATE OR REPLACE FUNCTION public.bonus_winnings_split(
  p_payout           numeric,
  p_bonus_proportion numeric
)
RETURNS TABLE (tngn_amount numeric, bonus_amount numeric)
LANGUAGE plpgsql IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cash_frac  numeric;
  v_tngn       numeric;
BEGIN
  v_cash_frac := CASE
    WHEN p_bonus_proportion >= 0.90 THEN 0.10
    WHEN p_bonus_proportion >= 0.80 THEN 0.20
    WHEN p_bonus_proportion >= 0.70 THEN 0.30
    ELSE 1.0
  END;
  v_tngn := round(p_payout * v_cash_frac, 4);
  RETURN QUERY SELECT v_tngn, p_payout - v_tngn;
END;
$$;

REVOKE ALL ON FUNCTION public.bonus_winnings_split(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bonus_winnings_split(numeric, numeric) TO service_role;

-- ── 4. place_bet — add bonus expiry check + bonus_proportion ─────────

CREATE OR REPLACE FUNCTION public.place_bet(
  p_user_id uuid,
  p_market_id bigint,
  p_outcome_index integer,
  p_stake_tngn numeric
)
RETURNS TABLE (
  bet_id uuid,
  net_stake numeric,
  entry_rake numeric,
  new_tngn_balance numeric,
  new_bonus_balance numeric,
  is_jackpot_eligible boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_rake_pct constant numeric := 0.015;
  v_min_stake     constant numeric := 100;
  v_jackpot_min   constant numeric := 500;
  v_points_per_naira_wagered constant numeric := 1.0 / 250.0;
  v_real numeric;
  v_bonus numeric;
  v_bonus_expires_at timestamptz;
  v_market record;
  v_options_len int;
  v_entry_rake numeric;
  v_net_stake numeric;
  v_new_real numeric;
  v_new_bonus numeric;
  v_bet_id uuid;
  v_jackpot boolean;
  v_pool_key text;
  v_current_pool numeric;
  v_points_to_award int;
  v_bonus_proportion numeric;
BEGIN
  IF p_user_id IS NULL OR p_market_id IS NULL
     OR p_outcome_index IS NULL OR p_stake_tngn IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF p_stake_tngn < v_min_stake THEN
    RAISE EXCEPTION 'stake_below_minimum' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome_index < 0 THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, status, closes_at, options, total_pool, pool_by_outcome
    INTO v_market
  FROM public.markets WHERE id = p_market_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'market_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_market.status <> 'open' THEN RAISE EXCEPTION 'market_not_open' USING ERRCODE = 'P0001'; END IF;
  IF v_market.closes_at <= now() THEN RAISE EXCEPTION 'market_closed' USING ERRCODE = 'P0001'; END IF;

  v_options_len := jsonb_array_length(v_market.options);
  IF p_outcome_index >= v_options_len THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = 'P0001';
  END IF;

  SELECT tngn_balance, bonus_balance, bonus_expires_at
    INTO v_real, v_bonus, v_bonus_expires_at
  FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002'; END IF;

  v_real  := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);

  -- Expire stale bonus in-transaction before computing available balance.
  IF v_bonus > 0 AND v_bonus_expires_at IS NOT NULL AND v_bonus_expires_at <= now() THEN
    v_bonus := 0;
    UPDATE public.users SET bonus_balance = 0, bonus_expires_at = NULL WHERE id = p_user_id;
  END IF;

  IF v_real + v_bonus < p_stake_tngn THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  v_entry_rake := round(p_stake_tngn * v_entry_rake_pct, 4);
  v_net_stake  := p_stake_tngn - v_entry_rake;
  v_jackpot    := p_stake_tngn >= v_jackpot_min;

  -- Balance deduction — real first, then bonus.
  IF v_real >= p_stake_tngn THEN
    v_new_real  := v_real - p_stake_tngn;
    v_new_bonus := v_bonus;
    v_bonus_proportion := 0.0;
  ELSE
    v_new_real  := 0;
    v_new_bonus := v_bonus - (p_stake_tngn - v_real);
    v_bonus_proportion := (p_stake_tngn - v_real) / p_stake_tngn;
  END IF;

  UPDATE public.users
    SET tngn_balance = v_new_real,
        bonus_balance = GREATEST(v_new_bonus, 0)
  WHERE id = p_user_id;

  INSERT INTO public.user_bets (
    user_id, market_id, outcome_index,
    stake_tngn, net_stake_tngn, entry_rake_tngn,
    is_jackpot_eligible, status, placed_at, bonus_proportion
  ) VALUES (
    p_user_id, p_market_id, p_outcome_index,
    p_stake_tngn, v_net_stake, v_entry_rake,
    v_jackpot, 'active', now(), v_bonus_proportion
  ) RETURNING id INTO v_bet_id;

  v_pool_key := p_outcome_index::text;
  v_current_pool := COALESCE((v_market.pool_by_outcome ->> v_pool_key)::numeric, 0);

  UPDATE public.markets
    SET total_pool = COALESCE(total_pool, 0) + v_net_stake,
        pool_by_outcome = pool_by_outcome
          || jsonb_build_object(v_pool_key, v_current_pool + v_net_stake)
  WHERE id = p_market_id;

  INSERT INTO public.treasury_log (
    type, amount_tngn, bet_id, user_id, market_id, created_at
  ) VALUES (
    'entry_rake', v_entry_rake, v_bet_id, p_user_id, p_market_id, now()
  );

  v_points_to_award := GREATEST(1, floor(p_stake_tngn * v_points_per_naira_wagered)::int);
  UPDATE public.users SET points = points + v_points_to_award WHERE id = p_user_id;
  INSERT INTO public.points_log (user_id, reason, points, related_bet_id)
  VALUES (p_user_id, 'bet_volume', v_points_to_award, v_bet_id);

  RETURN QUERY SELECT
    v_bet_id, v_net_stake, v_entry_rake,
    v_new_real, GREATEST(v_new_bonus, 0), v_jackpot;
END;
$$;

REVOKE ALL ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) TO service_role;

-- ── 5. place_bet_locked — add bonus expiry check + bonus_proportion ──

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
  c_entry_rake_pct           constant numeric := 0.015;
  c_min_stake                constant numeric := 100;
  c_jackpot_min              constant numeric := 500;
  c_points_per_naira_wagered constant numeric := 1.0 / 250.0;
  c_per_side_liability_cap   constant numeric := 40000;

  v_market                   record;
  v_num_outcomes             integer;
  v_seed_pool                numeric[];
  v_real_pool                numeric[];
  v_real                     numeric;
  v_bonus                    numeric;
  v_bonus_expires_at         timestamptz;
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
  v_bonus_proportion         numeric;
  i                          integer;
BEGIN
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

  v_entry_rake := round(p_stake_tngn * c_entry_rake_pct, 4);
  v_net_stake  := v_calc.net_stake;
  v_jackpot    := p_stake_tngn >= c_jackpot_min;

  -- Balance deduction — real first, then bonus.
  IF v_real >= p_stake_tngn THEN
    v_new_real  := v_real - p_stake_tngn;
    v_new_bonus := v_bonus;
    v_bonus_proportion := 0.0;
  ELSE
    v_new_real  := 0;
    v_new_bonus := v_bonus - (p_stake_tngn - v_real);
    v_bonus_proportion := (p_stake_tngn - v_real) / p_stake_tngn;
  END IF;

  UPDATE public.users
    SET tngn_balance  = v_new_real,
        bonus_balance = GREATEST(v_new_bonus, 0)
  WHERE id = p_user_id;

  INSERT INTO public.user_bets (
    user_id, market_id, outcome_index,
    stake_tngn, net_stake_tngn, entry_rake_tngn,
    is_jackpot_eligible, status, placed_at,
    locked_odds, vig_at_stake_pct, tier, bet_kind, bonus_proportion
  ) VALUES (
    p_user_id, p_market_id, p_outcome_index,
    p_stake_tngn, v_net_stake, v_entry_rake,
    v_jackpot, 'active', now(),
    v_calc.locked_odds, v_calc.vig_applied, v_calc.tier, 'single',
    v_bonus_proportion
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

REVOKE ALL ON FUNCTION public.place_bet_locked(uuid, bigint, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_bet_locked(uuid, bigint, integer, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.place_bet_locked(uuid, bigint, integer, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.place_bet_locked(uuid, bigint, integer, numeric) TO service_role;

-- ── 6. place_multiplier_slip — add bonus expiry check + bonus_proportion

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
  -- (using pre-deduction v_real) before the slip shell INSERT.
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

    SELECT * INTO v_calc
    FROM public.calculate_locked_odds_sql(
      v_seed_pool, v_real_pool, v_market.category, v_market.vig_pct,
      p_slip_stake, v_outcome_index, NULL, v_deployable, v_floor
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

  v_effective_comb := v_combined;
  IF v_net_slip_stake * v_combined > c_max_payout AND v_net_slip_stake > 0 THEN
    v_effective_comb := floor((c_max_payout / v_net_slip_stake) * 100) / 100;
  END IF;
  v_payout := LEAST(c_max_payout, round(v_net_slip_stake * v_effective_comb));

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

-- ── 7. settle_multiplier_for_market — apply bonus split on settlement ─

CREATE OR REPLACE FUNCTION public.settle_multiplier_for_market(
  p_market_id       bigint,
  p_winning_outcome integer,
  p_voided          boolean
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_max_payout  constant numeric := 200000;
  v_leg          record;
  v_slip         record;
  v_result       text;
  v_realized     numeric;
  v_product      numeric;
  v_payout       numeric;
  v_processed    integer := 0;
  v_all_void     boolean;
  v_tngn_payout  numeric;
  v_bonus_payout numeric;
BEGIN
  IF p_market_id IS NULL THEN
    RAISE EXCEPTION 'settle_multiplier_for_market: market_id null' USING ERRCODE = 'P0001';
  END IF;

  FOR v_leg IN
    SELECT id, slip_id, outcome_index, locked_odds
    FROM public.multiplier_legs
    WHERE market_id = p_market_id AND status = 'active'
    FOR UPDATE
  LOOP
    IF p_voided OR p_winning_outcome IS NULL THEN
      v_result := 'void';
      v_realized := 1.0;
    ELSIF v_leg.outcome_index = p_winning_outcome THEN
      v_result := 'won';
      v_realized := v_leg.locked_odds;
    ELSE
      v_result := 'lost';
      v_realized := NULL;
    END IF;

    UPDATE public.multiplier_legs
      SET status = v_result, realized_odds = v_realized, resolved_at = now()
    WHERE id = v_leg.id;

    v_processed := v_processed + 1;

    SELECT * INTO v_slip FROM public.multiplier_slips
    WHERE id = v_leg.slip_id FOR UPDATE;

    IF v_slip.status <> 'active' THEN
      CONTINUE;
    END IF;

    IF v_result = 'lost' THEN
      UPDATE public.multiplier_slips
        SET status = 'lost',
            legs_resolved = legs_resolved + 1,
            final_payout_tngn = 0,
            settled_at = now()
      WHERE id = v_slip.id;

      PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn, p_market_id);

      INSERT INTO public.notifications (user_id, type, message)
      VALUES (v_slip.user_id, 'multiplier_lost',
              'One leg of your Multiplier didn''t land — better luck next slip.');
      CONTINUE;
    END IF;

    UPDATE public.multiplier_slips
      SET legs_resolved = legs_resolved + 1,
          legs_won = legs_won + CASE WHEN v_result = 'won' THEN 1 ELSE 0 END
    WHERE id = v_slip.id;

    IF v_slip.legs_resolved + 1 >= v_slip.legs_total THEN
      SELECT
        COALESCE(EXP(SUM(LN(GREATEST(realized_odds, 0.0001)))), 1),
        BOOL_AND(status = 'void')
        INTO v_product, v_all_void
      FROM public.multiplier_legs
      WHERE slip_id = v_slip.id;

      v_payout := LEAST(c_max_payout, round(v_slip.net_slip_stake_tngn * v_product));

      IF v_all_void THEN
        -- Void: refund proportional to original funding source.
        -- Bonus-funded portion returns to bonus; cash-funded to tngn.
        v_tngn_payout  := round(v_slip.net_slip_stake_tngn * (1 - COALESCE(v_slip.bonus_proportion, 0)), 4);
        v_bonus_payout := v_slip.net_slip_stake_tngn - v_tngn_payout;

        UPDATE public.multiplier_slips
          SET status = 'voided',
              final_payout_tngn = v_slip.net_slip_stake_tngn,
              settled_at = now()
        WHERE id = v_slip.id;

        PERFORM public.credit_user(v_slip.user_id, v_tngn_payout, v_bonus_payout);

        UPDATE public.boost_wallet
          SET balance = balance + 1, updated_at = now()
        WHERE user_id = v_slip.user_id;
        INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
        SELECT v_slip.user_id, 1, 'slip_refund', v_slip.id, balance
        FROM public.boost_wallet WHERE user_id = v_slip.user_id;

        INSERT INTO public.notifications (user_id, type, message, amount)
        VALUES (v_slip.user_id, 'multiplier_voided',
                'Your Multiplier was voided (all legs postponed). Stake and Boost refunded.',
                v_slip.net_slip_stake_tngn);
      ELSE
        -- Won. Apply bonus winnings split then pay.
        SELECT tngn_amount, bonus_amount INTO v_tngn_payout, v_bonus_payout
        FROM public.bonus_winnings_split(v_payout, COALESCE(v_slip.bonus_proportion, 0));

        UPDATE public.multiplier_slips
          SET status = 'won',
              final_payout_tngn = v_payout,
              settled_at = now()
        WHERE id = v_slip.id;

        PERFORM public.credit_user(v_slip.user_id, v_tngn_payout, v_bonus_payout);
        PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn - v_payout, p_market_id);

        INSERT INTO public.notifications (user_id, type, message, amount)
        VALUES (v_slip.user_id, 'multiplier_won',
                'Your Multiplier hit! ₦' || to_char(v_payout, 'FM999,999,999') || ' credited. 🎉',
                v_payout);

        UPDATE public.users
          SET points = COALESCE(points, 0) + GREATEST(0, floor((v_payout - v_slip.slip_stake_tngn) / 100)::int)
        WHERE id = v_slip.user_id;
      END IF;
    END IF;
  END LOOP;

  RETURN v_processed;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_multiplier_for_market(bigint, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_multiplier_for_market(bigint, integer, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
