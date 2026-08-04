-- Fix: Multiplier slips could pay LESS for a bigger stake on the exact
-- same legs (e.g. a ₦200 5-leg slip paying more than a ₦2,000 slip on
-- identical picks).
--
-- Root cause: place_multiplier_slip priced EVERY leg by calling
-- calculate_locked_odds_sql with the FULL slip stake (p_slip_stake) as
-- that leg's pricing input, then multiplied the N resulting odds
-- together. Slippage makes a market's offered odds shrink as the
-- pricing stake grows — correct for a single bet, where the stake
-- genuinely enters that market's pool. But a parlay leg never puts the
-- slip stake into its market's pool at all (a slip is house-vs-user —
-- see lib/multiplier.ts's own design note: "there's nothing to fill").
-- Running the same full-stake slippage through N legs independently
-- compounds it N times, so combined odds collapsed roughly with
-- stake^legCount while payout only grows linearly with stake — a large
-- enough stake could pay strictly less than a small one.
--
-- Fix: price every leg's odds at a small FIXED reference stake
-- (₦100 — the platform's own minimum stake unit) instead of the real
-- slip stake. Each leg's locked odds are now independent of how much
-- the user actually stakes, matching the "fixed odds, frozen at
-- submit" design already documented in lib/multiplier.ts. Payout is
-- still strictly netSlipStake × combinedOdds, so it's now trivially
-- linear (monotonic) in stake. Mirrors the equivalent fix in
-- packages/app/lib/multiplier.ts / app/api/multiplier/quote/route.ts —
-- both sides must move together, same parity discipline as
-- calculate_locked_odds_sql's own TS/SQL pair.
--
-- Also fixes a second, smaller, pre-existing non-monotonicity found
-- while numerically verifying the fix above: the payout-cap trimming
-- math floored the combined odds to a coarse 0.01 grid and multiplied
-- payout back through that floored value, which could make payout dip
-- by a few hundred naira as stake grew across a grid boundary near the
-- ₦200,000 cap. Payout is now a direct clamp on the uncapped amount
-- (LEAST already guarantees the cap is never breached — the floored
-- intermediate was never necessary), with the stored effective_comb
-- derived FROM the resulting payout so it stays consistent with what's
-- actually paid.
--
-- The existing MULT_MAX_PAYOUT_TNGN (₦200,000) cap is untouched and
-- still bounds total house exposure per slip regardless of how legs
-- are priced — confirmed before making this change, not assumed.
--
-- Signature is unchanged; CREATE OR REPLACE keeps every existing
-- grant/caller intact.

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
  -- Fixed notional used ONLY to price each leg's odds — see migration
  -- header. MUST match MULT_LEG_PRICING_REFERENCE_STAKE in
  -- lib/multiplier.ts exactly.
  c_leg_pricing_reference_stake constant numeric := 100;

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

    -- Price the leg at the FIXED reference stake, never the real slip
    -- stake — see migration header. Tier (above) still derives from
    -- the real p_slip_stake; only the ODDS computation uses the fixed
    -- reference.
    SELECT * INTO v_calc
    FROM public.calculate_locked_odds_sql(
      v_seed_pool, v_real_pool, v_market.category, v_market.vig_pct,
      c_leg_pricing_reference_stake, v_outcome_index, NULL, v_deployable, v_floor
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
  -- Payout is a direct clamp on the uncapped amount — LEAST already
  -- guarantees it can never breach the ceiling, so there's no need to
  -- floor the combined odds to a coarse grid and multiply back through
  -- it (that approach could make payout dip non-monotonically as stake
  -- grew near the cap boundary — see migration header). effective_comb
  -- is derived FROM the (possibly capped) payout so the stored
  -- "effective multiplier" always agrees with what's actually paid.
  v_payout := LEAST(c_max_payout, round(v_net_slip_stake * v_combined));
  IF v_net_slip_stake > 0 AND v_net_slip_stake * v_combined > c_max_payout THEN
    v_effective_comb := round(v_payout / v_net_slip_stake, 2);
  ELSE
    v_effective_comb := v_combined;
  END IF;

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
  'Atomic parlay placement. Validates + prices each leg via calculate_locked_odds_sql at a FIXED ₦100 reference stake (never the real slip stake — see migration 20260710010000), enforces min leg odds (1.20), min combined (3.0), leg caps, and one-leg-per-event, spends a Boost, deducts the stake, and writes the slip + legs. House-vs-user: stake never enters a market pool. Reserve P&L is applied at settlement, not placement (conservative).';

NOTIFY pgrst, 'reload schema';
