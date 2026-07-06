-- Phase 7: Boosts RPCs + atomic Multiplier slip placement.
--
-- All SECURITY DEFINER, service-role only. The slip-placement RPC is
-- the SQL twin of lib/multiplier.ts validation + quoting, computing each
-- leg's odds through calculate_locked_odds_sql so the legs price exactly
-- as a single bet would.

-- Boost economy constants live in one place so grant/recharge agree.
--   SIGNUP_GRANT     5  free Boosts on first wallet touch
--   DAILY_CAP        5  daily recharge tops up TO this (not beyond)
--   RECHARGE_STEP    1  Boosts added per eligible day

-- ── ensure_boost_wallet ─────────────────────────────────────────────
-- Idempotent. Creates the wallet with the signup grant on first call;
-- returns the current balance thereafter. Logs the grant once.
CREATE OR REPLACE FUNCTION public.ensure_boost_wallet(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_signup_grant constant integer := 5;
  v_balance integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ensure_boost_wallet: p_user_id null' USING ERRCODE = 'P0001';
  END IF;

  SELECT balance INTO v_balance FROM public.boost_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF FOUND THEN
    RETURN v_balance;
  END IF;

  INSERT INTO public.boost_wallet (user_id, balance, lifetime_granted, last_recharge_at)
  VALUES (p_user_id, c_signup_grant, c_signup_grant, now())
  ON CONFLICT (user_id) DO NOTHING;

  -- Re-read in case of a concurrent insert that won the race.
  SELECT balance INTO v_balance FROM public.boost_wallet WHERE user_id = p_user_id;

  INSERT INTO public.boost_ledger (user_id, delta, reason, balance_after)
  VALUES (p_user_id, c_signup_grant, 'signup_grant', v_balance)
  ON CONFLICT DO NOTHING;

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_boost_wallet(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_boost_wallet(uuid) TO service_role;

-- ── recharge_boosts ─────────────────────────────────────────────────
-- Daily top-up. If the wallet is below the daily cap AND it hasn't been
-- recharged in the last ~20h, add one Boost (capped). Idempotent-ish:
-- repeated calls within the window are no-ops. Returns the new balance.
CREATE OR REPLACE FUNCTION public.recharge_boosts(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_daily_cap    constant integer := 5;
  c_step         constant integer := 1;
  c_window       constant interval := interval '20 hours';
  v_balance integer;
  v_last    timestamptz;
BEGIN
  PERFORM public.ensure_boost_wallet(p_user_id);

  SELECT balance, last_recharge_at
    INTO v_balance, v_last
  FROM public.boost_wallet WHERE user_id = p_user_id FOR UPDATE;

  -- Already at/above cap → nothing to do.
  IF v_balance >= c_daily_cap THEN
    RETURN v_balance;
  END IF;
  -- Recharged too recently → wait.
  IF v_last IS NOT NULL AND v_last > now() - c_window THEN
    RETURN v_balance;
  END IF;

  v_balance := LEAST(c_daily_cap, v_balance + c_step);

  UPDATE public.boost_wallet
    SET balance = v_balance,
        last_recharge_at = now(),
        updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.boost_ledger (user_id, delta, reason, balance_after)
  VALUES (p_user_id, c_step, 'daily_recharge', v_balance);

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.recharge_boosts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recharge_boosts(uuid) TO service_role;

-- ── place_multiplier_slip ───────────────────────────────────────────
-- Atomic parlay placement. Validates legs, prices each through
-- calculate_locked_odds_sql, combines, spends a Boost, deducts the
-- stake, and writes the slip + legs.
--
-- p_legs is a jsonb array: [{"market_id": 1, "outcome_index": 0}, ...].
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
  i                  integer;  -- outer leg loop
  j                  integer;  -- inner pool loop (distinct var: see note)
BEGIN
  -- ── Basic validation ────────────────────────────────────────────
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

  -- ── Lock user + balance ─────────────────────────────────────────
  SELECT tngn_balance, bonus_balance INTO v_real, v_bonus
  FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_real := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);
  IF v_real + v_bonus < p_slip_stake THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  -- ── Boost check ─────────────────────────────────────────────────
  PERFORM public.ensure_boost_wallet(p_user_id);
  SELECT balance INTO v_boost_balance FROM public.boost_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF COALESCE(v_boost_balance, 0) < 1 THEN
    RAISE EXCEPTION 'no_boosts' USING ERRCODE = 'P0001';
  END IF;

  -- ── Reserve snapshot (once) ─────────────────────────────────────
  SELECT deployable_tngn, floor_tngn INTO v_deployable, v_floor FROM public.reserve_health;
  IF v_deployable IS NULL OR v_floor IS NULL THEN
    RAISE EXCEPTION 'reserve_unavailable' USING ERRCODE = 'P0003';
  END IF;

  -- ── Stake/rake math computed up front so the slip shell can carry
  --     a valid net_slip_stake (CHECK > 0) before the legs FK to it. ──
  v_entry_rake := round(p_slip_stake * c_entry_rake_pct, 4);
  v_net_slip_stake := p_slip_stake - v_entry_rake;

  -- ── Insert the slip SHELL first so the legs' FK is satisfied ─────
  --     combined/effective default to 1 and payout to 0 (all pass
  --     their CHECKs); we UPDATE them after pricing every leg. If any
  --     leg fails, the whole function rolls back, shell included.
  v_slip_id := gen_random_uuid();
  INSERT INTO public.multiplier_slips (
    id, user_id, slip_stake_tngn, net_slip_stake_tngn, entry_rake_tngn,
    combined_odds, effective_combined_odds, payout_tngn, tier,
    legs_total, legs_resolved, legs_won, status
  ) VALUES (
    v_slip_id, p_user_id, p_slip_stake, v_net_slip_stake, v_entry_rake,
    1, 1, 0, v_tier,
    v_leg_count, 0, 0, 'active'
  );

  -- ── Price each leg ──────────────────────────────────────────────
  FOR i IN 0..v_leg_count - 1 LOOP
    v_leg := p_legs -> i;
    v_market_id := (v_leg ->> 'market_id')::bigint;
    v_outcome_index := (v_leg ->> 'outcome_index')::integer;

    IF v_market_id IS NULL OR v_outcome_index IS NULL OR v_outcome_index < 0 THEN
      RAISE EXCEPTION 'invalid_leg' USING ERRCODE = 'P0001';
    END IF;

    -- One leg per event.
    IF v_market_id = ANY(v_market_ids) THEN
      RAISE EXCEPTION 'duplicate_event' USING ERRCODE = 'P0001';
    END IF;
    v_market_ids := array_append(v_market_ids, v_market_id);

    -- Lock + check the market.
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

    -- Build pools. NOTE: distinct loop var `j` — PL/pgSQL integer FOR
    -- loops auto-scope their counter, but reusing `i` here would still
    -- be confusing/fragile, so we use `j` explicitly.
    v_seed_pool := ARRAY[]::numeric[];
    v_real_pool := ARRAY[]::numeric[];
    FOR j IN 0..v_num_outcomes - 1 LOOP
      v_seed_pool := array_append(v_seed_pool, COALESCE((v_market.seed_pool ->> j::text)::numeric, 0));
      v_real_pool := array_append(v_real_pool, COALESCE((v_market.pool_by_outcome ->> j::text)::numeric, 0));
    END LOOP;

    -- Price the leg using the SLIP stake (tier off slip; slippage on
    -- the full slip stake — conservative, house-favourable).
    SELECT * INTO v_calc
    FROM public.calculate_locked_odds_sql(
      v_seed_pool, v_real_pool, v_market.category, v_market.vig_pct,
      p_slip_stake, v_outcome_index, NULL, v_deployable, v_floor
    );

    -- Min per-leg odds.
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

  -- ── Combined-odds floor ─────────────────────────────────────────
  v_combined := round(v_combined, 2);
  IF v_combined < c_min_combined THEN
    RAISE EXCEPTION 'combined_below_min' USING ERRCODE = 'P0001';
  END IF;

  -- ── Payout math (mirror lib/multiplier.quoteSlip) ───────────────
  v_effective_comb := v_combined;
  IF v_net_slip_stake * v_combined > c_max_payout AND v_net_slip_stake > 0 THEN
    v_effective_comb := floor((c_max_payout / v_net_slip_stake) * 100) / 100;
  END IF;
  v_payout := LEAST(c_max_payout, round(v_net_slip_stake * v_effective_comb));

  -- ── Deduct stake (real first, then bonus) ───────────────────────
  IF v_real >= p_slip_stake THEN
    v_new_real := v_real - p_slip_stake;
    v_new_bonus := v_bonus;
  ELSE
    v_new_real := 0;
    v_new_bonus := v_bonus - (p_slip_stake - v_real);
  END IF;

  UPDATE public.users
    SET tngn_balance = v_new_real,
        bonus_balance = GREATEST(v_new_bonus, 0)
  WHERE id = p_user_id;

  -- ── Spend a Boost ───────────────────────────────────────────────
  v_boost_balance := v_boost_balance - 1;
  UPDATE public.boost_wallet
    SET balance = v_boost_balance,
        lifetime_spent = lifetime_spent + 1,
        updated_at = now()
  WHERE user_id = p_user_id;
  INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
  VALUES (p_user_id, -1, 'slip_spend', v_slip_id, v_boost_balance);

  -- ── Finalise the slip with the priced numbers ───────────────────
  UPDATE public.multiplier_slips
    SET combined_odds = v_combined,
        effective_combined_odds = v_effective_comb,
        payout_tngn = v_payout
  WHERE id = v_slip_id;

  -- ── Entry rake to treasury + volume points ──────────────────────
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
  'Atomic parlay placement. Validates + prices each leg via calculate_locked_odds_sql (tier + slippage off the slip stake), enforces min leg odds (1.20), min combined (3.0), leg caps, and one-leg-per-event, spends a Boost, deducts the stake, and writes the slip + legs. House-vs-user: stake never enters a market pool. Reserve P&L is applied at settlement, not placement (conservative).';

NOTIFY pgrst, 'reload schema';
