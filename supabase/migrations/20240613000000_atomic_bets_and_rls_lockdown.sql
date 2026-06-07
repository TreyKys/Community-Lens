-- ================================================================
-- Pre-production hardening: atomic bets, RLS lockdown, per-outcome
-- pool tracking for the live potential-winnings calculator.
-- ================================================================
-- Fixes from QA red-team audit (2026-06-05):
--   1. RLS: clients could update their own balance directly
--   2. /api/bet was non-atomic — race condition on concurrent bets
--   3. Concurrent load test only succeeded 16/100 due to (2)
--   4. No per-outcome pool tracking, so payout preview required N
--      separate sub-queries per market render.
-- ================================================================

-- 1. KILL THE BALANCE-BYPASS HOLE ---------------------------------
-- The old policy allowed `supabase.from('users').update({...})` from
-- any authenticated client. Postgres RLS can't express "you may update
-- some columns but not balance/bonus_balance" without a trigger, and
-- all profile + balance writes already route through service-role API
-- handlers. The safest fix is to drop client UPDATE entirely.
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;

-- (SELECT policy stays — users still read their own row.)

-- 2. PER-OUTCOME POOL TRACKING ------------------------------------
-- Keyed by stringified outcome_index, values are running sums of
-- net_stake_tngn. Maintained transactionally by place_bet().
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS pool_by_outcome jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill from existing user_bets so live markets keep working.
WITH per_outcome AS (
  SELECT market_id, jsonb_object_agg(outcome_index::text, total) AS pools
  FROM (
    SELECT market_id, outcome_index, sum(net_stake_tngn) AS total
    FROM public.user_bets
    WHERE status IN ('active', 'won', 'lost')
    GROUP BY market_id, outcome_index
  ) t
  GROUP BY market_id
)
UPDATE public.markets m
SET pool_by_outcome = per_outcome.pools
FROM per_outcome
WHERE m.id = per_outcome.market_id;

-- 3. ATOMIC place_bet RPC -----------------------------------------
-- Replaces the read-validate-insert-update sequence in /api/bet
-- with a single SECURITY DEFINER transaction. Row locks prevent
-- the double-spend race the QA found.
--
-- Lock order is strict: market FIRST, then user. Any other write
-- path that touches both tables must use the same order to avoid
-- deadlocks. (Resolution endpoint only writes to users + user_bets,
-- not markets, so it doesn't conflict.)
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
  v_real numeric;
  v_bonus numeric;
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
BEGIN
  -- Input validation. Raise distinct error codes so the API can
  -- map them to 400 / 404 cleanly.
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

  -- LOCK MARKET FIRST.
  SELECT id, status, closes_at, options, total_pool, pool_by_outcome
    INTO v_market
  FROM public.markets
  WHERE id = p_market_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'market_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_market.status <> 'open' THEN
    RAISE EXCEPTION 'market_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF v_market.closes_at <= now() THEN
    RAISE EXCEPTION 'market_closed' USING ERRCODE = 'P0001';
  END IF;

  v_options_len := jsonb_array_length(v_market.options);
  IF p_outcome_index >= v_options_len THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK USER SECOND.
  SELECT tngn_balance, bonus_balance
    INTO v_real, v_bonus
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_real := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);
  IF v_real + v_bonus < p_stake_tngn THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  v_entry_rake := round(p_stake_tngn * v_entry_rake_pct, 4);
  v_net_stake  := p_stake_tngn - v_entry_rake;
  v_jackpot    := p_stake_tngn >= v_jackpot_min;

  -- Spend real balance first, then bonus.
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
    is_jackpot_eligible, status, placed_at
  ) VALUES (
    p_user_id, p_market_id, p_outcome_index,
    p_stake_tngn, v_net_stake, v_entry_rake,
    v_jackpot, 'active', now()
  ) RETURNING id INTO v_bet_id;

  v_pool_key := p_outcome_index::text;
  v_current_pool := COALESCE((v_market.pool_by_outcome ->> v_pool_key)::numeric, 0);

  UPDATE public.markets
    SET total_pool      = COALESCE(total_pool, 0) + v_net_stake,
        pool_by_outcome = pool_by_outcome
          || jsonb_build_object(v_pool_key, v_current_pool + v_net_stake)
  WHERE id = p_market_id;

  INSERT INTO public.treasury_log (
    type, amount_tngn, bet_id, user_id, market_id, created_at
  ) VALUES (
    'entry_rake', v_entry_rake, v_bet_id, p_user_id, p_market_id, now()
  );

  RETURN QUERY SELECT
    v_bet_id,
    v_net_stake,
    v_entry_rake,
    v_new_real,
    GREATEST(v_new_bonus, 0),
    v_jackpot;
END;
$$;

-- Only the API service role may invoke this — clients can't
-- call rpc('place_bet') from the browser.
REVOKE ALL ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.place_bet(uuid, bigint, integer, numeric) TO service_role;

-- 4. AUTO-CREATE public.users ON SIGNUP ---------------------------
-- QA found that 2/22 concurrent bots had no public.users row after
-- auth signup. Without a trigger, that row is created lazily by app
-- code, which is racy under concurrent OTP completions. This trigger
-- makes the public profile creation atomic with auth.users insert.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, phone, tngn_balance, bonus_balance, created_at)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.phone,
    0,
    0,
    now()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill any orphan auth.users rows that don't have a public profile yet.
INSERT INTO public.users (id, email, phone, tngn_balance, bonus_balance, created_at)
SELECT au.id, au.email, au.phone, 0, 0, COALESCE(au.created_at, now())
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
