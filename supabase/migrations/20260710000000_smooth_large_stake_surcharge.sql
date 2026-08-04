-- Fix: the large-stake surcharge was a hard step (stake > 50% of
-- opposing effective pool → +0.01 vig, else +0), which made total
-- guaranteed floor payout FALL as stake rose past that threshold —
-- e.g. staking ₦501 instead of ₦500 could pay strictly less, because
-- the instantaneous +1% vig outweighed the extra ₦1 of stake. That's
-- never correct for any pricing engine: a bigger stake must never buy
-- less. Replaces the step with a ramp from 0 at 50% of opposing
-- effective up to the full 0.01 by 100%, so the surcharge — and
-- therefore payout — is continuous in stake. Mirrors the same fix in
-- lib/lockedOdds.ts's computeVigSurcharges. Signature is unchanged;
-- CREATE OR REPLACE keeps every existing grant/caller intact.

CREATE OR REPLACE FUNCTION public.calculate_locked_odds_sql(
  p_seed_pool numeric[],         -- house seed by outcome, 1-indexed
  p_real_pool numeric[],         -- crowd stakes (net), by outcome, 1-indexed
  p_category text,               -- markets.category — drives base vig
  p_vig_override numeric,        -- markets.vig_pct — overrides category default if not null
  p_stake numeric,               -- gross stake
  p_outcome_index integer,       -- 0-indexed to match TS / JS conventions
  p_accuracy_tier text,          -- users.accuracy_tier — null = rookie
  p_deployable_tngn numeric,     -- reserve_health.deployable_tngn
  p_floor_tngn numeric           -- reserve_health.floor_tngn
)
RETURNS TABLE (
  locked_odds              numeric,
  vig_applied              numeric,
  tier                     smallint,
  net_stake                numeric,
  floor_payout             numeric,
  upper_payout             numeric,
  category_vig             numeric,
  thin_pool_surcharge      numeric,
  large_stake_surcharge    numeric,
  reserve_stress_surcharge numeric,
  accuracy_discount        numeric
)
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  -- Constants — MUST match lib/lockedOdds.ts exactly. If you change
  -- one here, change the other in the same PR, and the parity test
  -- will assert the change holds.
  c_tier2_min_stake           constant numeric := 500;
  c_tier1_floor               constant numeric := 1.03;
  c_tier2_floor               constant numeric := 1.02;
  c_entry_rake_pct            constant numeric := 0.015;
  c_max_odds                  constant numeric := 25;
  c_min_vig                   constant numeric := 0.04;
  c_max_vig                   constant numeric := 0.15;
  c_range_upper_cap_ratio     constant numeric := 2.5;

  -- Working state
  v_num_outcomes              integer;
  v_tier                      smallint;
  v_naive_tier_floor          numeric;
  v_tier_floor                numeric;
  v_net_stake                 numeric;
  v_effective_with_stake      numeric[];
  v_total                     numeric;
  v_pool_chosen                numeric;
  v_opposing_effective        numeric;
  v_stake_ratio                numeric;
  v_raw_fair_odds             numeric;
  v_category_vig              numeric;
  v_thin_pool_surcharge       numeric;
  v_large_stake_surcharge     numeric;
  v_reserve_stress_surcharge  numeric;
  v_accuracy_discount         numeric;
  v_pre_clamp_vig             numeric;
  v_final_vig                 numeric;
  v_odds                      numeric;
  v_locked_odds               numeric;
  v_floor_payout              numeric;
  v_total_seed                numeric := 0;
  v_total_real                numeric := 0;
  v_safe_seed                 numeric;
  v_safe_real                 numeric;
  v_pool_ratio                numeric;
  v_projected_chosen          numeric;
  v_projected_total           numeric;
  v_projected_raw_odds        numeric;
  v_projected_odds            numeric;
  v_projected_payout          numeric;
  v_upper_capped              numeric;
  v_upper_payout              numeric;
  i                           integer;
BEGIN
  -- ── 0. Programmer-error guards ───────────────────────────────────
  IF p_stake IS NULL OR p_stake <= 0 THEN
    RAISE EXCEPTION 'lockedOdds_sql: stake must be a positive finite number, got %', p_stake;
  END IF;
  IF p_outcome_index IS NULL OR p_outcome_index < 0 THEN
    RAISE EXCEPTION 'lockedOdds_sql: outcomeIndex must be a non-negative integer, got %', p_outcome_index;
  END IF;
  IF p_seed_pool IS NULL OR p_real_pool IS NULL THEN
    RAISE EXCEPTION 'lockedOdds_sql: seed_pool and real_pool must not be null';
  END IF;
  v_num_outcomes := COALESCE(array_length(p_seed_pool, 1), 0);
  IF v_num_outcomes < 2 THEN
    RAISE EXCEPTION 'lockedOdds_sql: market must have at least 2 outcomes, got %', v_num_outcomes;
  END IF;
  IF p_outcome_index >= v_num_outcomes THEN
    RAISE EXCEPTION 'lockedOdds_sql: outcomeIndex % out of range for % outcomes', p_outcome_index, v_num_outcomes;
  END IF;
  IF COALESCE(array_length(p_real_pool, 1), 0) <> v_num_outcomes THEN
    RAISE EXCEPTION 'lockedOdds_sql: realPool length does not match seedPool length';
  END IF;

  -- ── 1. Tier resolution ───────────────────────────────────────────
  v_tier := CASE WHEN p_stake < c_tier2_min_stake THEN 1 ELSE 2 END;
  v_naive_tier_floor := CASE WHEN v_tier = 1 THEN c_tier1_floor ELSE c_tier2_floor END;

  -- ── 2. Invisible entry rake ─────────────────────────────────────
  v_net_stake := p_stake * (1 - c_entry_rake_pct);

  -- ── 2a. Boundary-monotonic floor ─────────────────────────────────
  -- See lib/lockedOdds.ts step 2a for the explanation. For Tier 2 we
  -- pin the floor multiplier so floor payout at any stake >= 500 is
  -- at least Tier 1's floor payout AT THE BOUNDARY. Eliminates the
  -- "stake more, get paid less" cliff at the 499/500 transition.
  v_tier_floor := CASE WHEN v_tier = 2
    THEN GREATEST(
      c_tier2_floor,
      (c_tier2_min_stake * (1 - c_entry_rake_pct) * c_tier1_floor) / v_net_stake
    )
    ELSE v_naive_tier_floor
  END;

  -- ── 3. Effective pools, cleaning negatives/nulls to zero ────────
  v_effective_with_stake := ARRAY[]::numeric[];
  FOR i IN 1..v_num_outcomes LOOP
    v_safe_seed := COALESCE(p_seed_pool[i], 0);
    IF v_safe_seed < 0 THEN v_safe_seed := 0; END IF;
    v_safe_real := COALESCE(p_real_pool[i], 0);
    IF v_safe_real < 0 THEN v_safe_real := 0; END IF;
    v_total_seed := v_total_seed + v_safe_seed;
    v_total_real := v_total_real + v_safe_real;
    v_effective_with_stake := array_append(v_effective_with_stake, v_safe_seed + v_safe_real);
  END LOOP;

  -- ── 4. Slippage protection — add this stake to chosen pool BEFORE
  --       pricing. Postgres arrays are 1-based; outcome_index is 0-based.
  v_effective_with_stake[p_outcome_index + 1] :=
    v_effective_with_stake[p_outcome_index + 1] + v_net_stake;

  v_total := 0;
  FOR i IN 1..v_num_outcomes LOOP
    v_total := v_total + v_effective_with_stake[i];
  END LOOP;
  v_pool_chosen := v_effective_with_stake[p_outcome_index + 1];

  -- ── 5. Dynamic vig composition ──────────────────────────────────
  -- 5a. Base from per-market override or per-category default
  IF p_vig_override IS NOT NULL THEN
    v_category_vig := GREATEST(c_min_vig, LEAST(c_max_vig, p_vig_override));
  ELSE
    v_category_vig := CASE p_category
      WHEN 'sports'        THEN 0.07
      WHEN 'sports_top'    THEN 0.06
      WHEN 'sports_props'  THEN 0.07
      WHEN 'combat'        THEN 0.08
      WHEN 'economy'       THEN 0.09
      WHEN 'economics'     THEN 0.09
      WHEN 'finance'       THEN 0.09
      WHEN 'crypto'        THEN 0.08
      WHEN 'entertainment' THEN 0.09
      WHEN 'politics'      THEN 0.10
      WHEN 'culture'       THEN 0.10
      ELSE 0.08
    END;
  END IF;

  -- 5b. Thin-pool surcharge — real flow vs. seed ratio.
  IF v_total_seed > 0 THEN
    v_pool_ratio := v_total_real / v_total_seed;
    v_thin_pool_surcharge := CASE
      WHEN v_pool_ratio < 1 THEN 0.02
      WHEN v_pool_ratio < 2 THEN 0.01
      ELSE 0
    END;
  ELSIF v_total_real > 0 THEN
    v_thin_pool_surcharge := 0.01;
  ELSE
    v_thin_pool_surcharge := 0.02;
  END IF;

  -- 5c. Large-stake surcharge — ramped smoothly from 0 at 50% of
  -- opposing effective pool up to the full 0.01 by 100%, instead of a
  -- hard step at the 50% threshold (see migration header for why the
  -- step was a bug). Mirrors lib/lockedOdds.ts exactly.
  v_opposing_effective := 0;
  FOR i IN 1..v_num_outcomes LOOP
    IF (i - 1) <> p_outcome_index THEN
      v_safe_seed := COALESCE(p_seed_pool[i], 0);
      IF v_safe_seed < 0 THEN v_safe_seed := 0; END IF;
      v_safe_real := COALESCE(p_real_pool[i], 0);
      IF v_safe_real < 0 THEN v_safe_real := 0; END IF;
      v_opposing_effective := v_opposing_effective + v_safe_seed + v_safe_real;
    END IF;
  END LOOP;
  IF v_opposing_effective > 0 THEN
    v_stake_ratio := p_stake / v_opposing_effective;
    v_large_stake_surcharge := 0.01 * GREATEST(0, LEAST(1, (v_stake_ratio - 0.5) / 0.5));
  ELSE
    v_large_stake_surcharge := 0;
  END IF;

  -- 5d. Reserve-stress surcharge — deployable < 60% of floor.
  v_reserve_stress_surcharge := CASE
    WHEN p_floor_tngn > 0 AND p_deployable_tngn < p_floor_tngn * 0.6 THEN 0.02
    ELSE 0
  END;

  -- 5e. Accuracy-privilege discount.
  v_accuracy_discount := CASE
    WHEN p_accuracy_tier IN ('pro', 'elite') THEN 0.02
    ELSE 0
  END;

  -- 5f. Compose + clamp.
  v_pre_clamp_vig := v_category_vig
                   + v_thin_pool_surcharge
                   + v_large_stake_surcharge
                   + v_reserve_stress_surcharge
                   - v_accuracy_discount;
  v_final_vig := GREATEST(c_min_vig, LEAST(c_max_vig, v_pre_clamp_vig));

  -- ── 6. Degenerate-state guard ────────────────────────────────────
  -- Unreachable in practice (we add stake to chosen above), but if
  -- somehow total or chosen is <= 0, return MAX_ODDS at the tier
  -- floor rather than divide-by-zero.
  IF v_total <= 0 OR v_pool_chosen <= 0 THEN
    v_locked_odds := GREATEST(v_tier_floor, c_max_odds);
    v_floor_payout := round(v_net_stake * v_locked_odds);
    RETURN QUERY SELECT
      v_locked_odds,
      v_final_vig,
      v_tier,
      v_net_stake,
      v_floor_payout,
      v_floor_payout,
      v_category_vig,
      v_thin_pool_surcharge,
      v_large_stake_surcharge,
      v_reserve_stress_surcharge,
      v_accuracy_discount;
    RETURN;
  END IF;

  -- ── 7-10. Raw odds → vig → floor → ceiling ──────────────────────
  v_raw_fair_odds := v_total / v_pool_chosen;
  v_odds := v_raw_fair_odds / (1 + v_final_vig);
  IF v_odds < v_tier_floor THEN v_odds := v_tier_floor; END IF;
  IF v_odds > c_max_odds THEN v_odds := c_max_odds; END IF;

  -- ── 11. Deterministic rounding to 2dp ───────────────────────────
  -- Postgres `round(numeric, integer)` rounds half away from zero,
  -- which matches JS `Math.round(x * 100) / 100` for positive values.
  v_locked_odds := round(v_odds, 2);

  -- ── 12. Floor payout ────────────────────────────────────────────
  v_floor_payout := round(v_net_stake * v_locked_odds);

  -- ── 13. Upper payout projection ─────────────────────────────────
  -- Chosen side stays as-is. Opposing real doubles (floored at 1).
  v_projected_chosen := v_pool_chosen;
  v_projected_total := v_projected_chosen;
  FOR i IN 1..v_num_outcomes LOOP
    IF (i - 1) <> p_outcome_index THEN
      v_safe_seed := COALESCE(p_seed_pool[i], 0);
      IF v_safe_seed < 0 THEN v_safe_seed := 0; END IF;
      v_safe_real := COALESCE(p_real_pool[i], 0);
      IF v_safe_real < 0 THEN v_safe_real := 0; END IF;
      v_projected_total := v_projected_total + v_safe_seed + GREATEST(1, v_safe_real * 2);
    END IF;
  END LOOP;

  IF v_projected_chosen <= 0 OR v_projected_total <= 0 THEN
    v_upper_payout := v_floor_payout;
  ELSE
    v_projected_raw_odds := v_projected_total / v_projected_chosen;
    v_projected_odds := LEAST(c_max_odds, v_projected_raw_odds / (1 + v_final_vig));
    v_projected_payout := round(v_net_stake * v_projected_odds);
    v_upper_capped := LEAST(v_projected_payout, round(v_floor_payout * c_range_upper_cap_ratio));
    v_upper_payout := GREATEST(v_floor_payout, v_upper_capped);
  END IF;

  RETURN QUERY SELECT
    v_locked_odds,
    v_final_vig,
    v_tier,
    v_net_stake,
    v_floor_payout,
    v_upper_payout,
    v_category_vig,
    v_thin_pool_surcharge,
    v_large_stake_surcharge,
    v_reserve_stress_surcharge,
    v_accuracy_discount;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_locked_odds_sql(
  numeric[], numeric[], text, numeric, numeric, integer, text, numeric, numeric
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.calculate_locked_odds_sql(
  numeric[], numeric[], text, numeric, numeric, integer, text, numeric, numeric
) TO service_role;

COMMENT ON FUNCTION public.calculate_locked_odds_sql IS
  'PL/pgSQL twin of lib/lockedOdds.ts. Pure, IMMUTABLE, parallel-safe. Called by place_bet_locked and the locked-odds settlement path so the odds frozen on the bet row are computed by mathematically identical code to what the user saw in the modal. Parity is enforced by lib/lockedOdds.parity.test.ts. Large-stake surcharge is a smooth ramp (fixed 2026-07-10) — see this migration header.';
