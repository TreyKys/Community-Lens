-- ================================================================
-- Loyalty + acquisition systems wave: VIP accounts, dual-track
-- referrals, points/leaderboard plumbing, T&C acceptance log, and
-- Random Bet Insurance bookkeeping.
-- ================================================================

-- 1. USERS: VIP flag, points, terms acceptance, referral attribution -----
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_vip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS points integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tos_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS tos_version text,
  -- referred_by_user_id captures BOTH normal-user referrals and VIP referrals.
  -- referred_by_is_vip is stored so the resolution-rake split can be a fast
  -- index lookup at payout time instead of a second join.
  ADD COLUMN IF NOT EXISTS referred_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referred_by_is_vip boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_referred_by ON public.users(referred_by_user_id) WHERE referred_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_is_vip ON public.users(is_vip) WHERE is_vip = true;

-- 2. REFERRAL CODES ------------------------------------------------------
-- Codes are unique, owned by a single user, and tagged with the owner's tier
-- at issue time. VIPs get their own codes via the admin panel; normal users
-- get auto-assigned codes after sign-up.
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code text UNIQUE NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  is_vip_code boolean NOT NULL DEFAULT false,
  rake_share_pct numeric NOT NULL DEFAULT 0,  -- only meaningful for VIP codes
  uses_count integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_owner ON public.referral_codes(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code_upper ON public.referral_codes(upper(code));

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own referral codes" ON public.referral_codes
  FOR SELECT USING (auth.uid() = owner_user_id);

-- 3. POINTS LOG ----------------------------------------------------------
-- Every point change is recorded for leaderboard auditability and reversal.
CREATE TABLE IF NOT EXISTS public.points_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason text NOT NULL,            -- 'bet_volume' | 'bet_win' | 'referral_normal' | 'referral_vip' | 'admin_adjust'
  points integer NOT NULL,          -- can be negative
  related_bet_id uuid,
  related_user_id uuid,             -- e.g. the referee
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_points_log_user ON public.points_log(user_id, created_at DESC);

-- 4. VIP REFERRAL EARNINGS ----------------------------------------------
-- Tracks every slice of resolution rake routed to a VIP referrer at market
-- resolution time. Powers the VIP's earnings dashboard.
CREATE TABLE IF NOT EXISTS public.vip_referral_earnings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vip_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bet_id uuid NOT NULL,
  market_id bigint NOT NULL REFERENCES public.markets(id),
  rake_share_pct numeric NOT NULL,    -- the % applied at the time of payout
  rake_share_amount numeric NOT NULL, -- in tNGN
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vip_earnings_vip ON public.vip_referral_earnings(vip_user_id, created_at DESC);

ALTER TABLE public.vip_referral_earnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "VIPs can read own earnings" ON public.vip_referral_earnings
  FOR SELECT USING (auth.uid() = vip_user_id);

-- 5. RANDOM BET INSURANCE EVENTS -----------------------------------------
-- Single source of truth for who has been insured (eliminates the
-- is_first_bet_refunded race on user_bets). Indexed for fast lookup.
CREATE TABLE IF NOT EXISTS public.bet_insurance_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bet_id uuid NOT NULL,
  market_id bigint NOT NULL REFERENCES public.markets(id),
  refund_amount_tngn numeric NOT NULL,
  trigger_reason text NOT NULL,      -- 'first_bet' | 'random_volume_based'
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bet_insurance_user ON public.bet_insurance_events(user_id, created_at DESC);

-- 6. TERMS ACCEPTANCE LOG ------------------------------------------------
-- Litigation-grade audit trail of every T&C acceptance, with IP + UA.
CREATE TABLE IF NOT EXISTS public.terms_acceptance_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tos_version text NOT NULL,
  accepted_at timestamptz DEFAULT now(),
  ip_address text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS idx_terms_accept_user ON public.terms_acceptance_log(user_id, accepted_at DESC);

-- 7. REDEEM REFERRAL FUNCTION --------------------------------------------
-- Atomically: validates the code, ensures the user isn't redeeming twice or
-- self-referring, sets users.referred_by_*, increments the code's uses_count,
-- and awards the referrer their cohort-appropriate bonus.
--
-- For NORMAL codes:  referrer gets +200 pts + ₦200 in bonus_balance
-- For VIP codes:     referrer gets +1000 pts (resolution-rake share kicks
--                    in at payout time, not redeem time)
CREATE OR REPLACE FUNCTION public.redeem_referral_code(
  p_user_id uuid,
  p_code text
)
RETURNS TABLE (
  ok boolean,
  message text,
  owner_id uuid,
  is_vip_code boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_row record;
  v_already_referred uuid;
BEGIN
  IF p_user_id IS NULL OR p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RETURN QUERY SELECT false, 'invalid_input'::text, NULL::uuid, false;
    RETURN;
  END IF;

  -- Idempotency: if this user already has a referrer, return success without changes
  SELECT referred_by_user_id INTO v_already_referred
  FROM public.users WHERE id = p_user_id;

  IF v_already_referred IS NOT NULL THEN
    RETURN QUERY SELECT true, 'already_redeemed'::text, v_already_referred, false;
    RETURN;
  END IF;

  SELECT rc.id, rc.code, rc.owner_user_id, rc.is_vip_code, rc.is_active
    INTO v_code_row
  FROM public.referral_codes rc
  WHERE upper(rc.code) = upper(trim(p_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'code_not_found'::text, NULL::uuid, false;
    RETURN;
  END IF;

  IF NOT v_code_row.is_active THEN
    RETURN QUERY SELECT false, 'code_inactive'::text, NULL::uuid, false;
    RETURN;
  END IF;

  IF v_code_row.owner_user_id = p_user_id THEN
    RETURN QUERY SELECT false, 'self_referral'::text, NULL::uuid, false;
    RETURN;
  END IF;

  -- Attribute
  UPDATE public.users
    SET referred_by_user_id = v_code_row.owner_user_id,
        referred_by_is_vip  = v_code_row.is_vip_code
  WHERE id = p_user_id;

  UPDATE public.referral_codes
    SET uses_count = uses_count + 1
  WHERE id = v_code_row.id;

  -- Reward the referrer
  IF v_code_row.is_vip_code THEN
    UPDATE public.users SET points = points + 1000 WHERE id = v_code_row.owner_user_id;
    INSERT INTO public.points_log (user_id, reason, points, related_user_id)
    VALUES (v_code_row.owner_user_id, 'referral_vip', 1000, p_user_id);
  ELSE
    UPDATE public.users
      SET points = points + 200,
          bonus_balance = COALESCE(bonus_balance, 0) + 200
    WHERE id = v_code_row.owner_user_id;
    INSERT INTO public.points_log (user_id, reason, points, related_user_id)
    VALUES (v_code_row.owner_user_id, 'referral_normal', 200, p_user_id);
  END IF;

  RETURN QUERY SELECT true, 'ok'::text, v_code_row.owner_user_id, v_code_row.is_vip_code;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_referral_code(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_referral_code(uuid, text) TO service_role;

-- 8. AUTO-GENERATE REFERRAL CODES ON SIGNUP ------------------------------
-- Every new user gets a normal referral code derived from their UUID,
-- so they can refer friends without admin intervention.
CREATE OR REPLACE FUNCTION public.ensure_user_referral_code(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing text;
  v_attempt text;
  v_seed text;
BEGIN
  SELECT code INTO v_existing
  FROM public.referral_codes
  WHERE owner_user_id = p_user_id AND NOT is_vip_code
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Derive a 6-char code from the user's UUID; if it collides (vanishingly
  -- unlikely) just retry with a random suffix.
  v_seed := upper(replace(p_user_id::text, '-', ''));
  FOR i IN 1..5 LOOP
    IF i = 1 THEN
      v_attempt := substr(v_seed, 1, 6);
    ELSE
      v_attempt := substr(v_seed, 1, 4) || upper(substr(md5(random()::text), 1, 2));
    END IF;
    BEGIN
      INSERT INTO public.referral_codes (code, owner_user_id, is_vip_code, rake_share_pct)
      VALUES (v_attempt, p_user_id, false, 0)
      RETURNING code INTO v_existing;
      RETURN v_existing;
    EXCEPTION WHEN unique_violation THEN
      -- try again
      CONTINUE;
    END;
  END LOOP;
  RAISE EXCEPTION 'could_not_generate_referral_code';
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_user_referral_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_user_referral_code(uuid) TO service_role;

-- Update the existing handle_new_auth_user trigger so referral codes are
-- generated immediately after the public.users row is created.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, phone, tngn_balance, bonus_balance, created_at)
  VALUES (NEW.id, NEW.email, NEW.phone, 0, 0, now())
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.ensure_user_referral_code(NEW.id);
  RETURN NEW;
END;
$$;

-- Backfill referral codes for every existing user that doesn't have one.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.users LOOP
    PERFORM public.ensure_user_referral_code(r.id);
  END LOOP;
END $$;

-- 9. ADMIN HELPER: CREATE A VIP ACCOUNT ----------------------------------
-- Idempotently promotes a user to VIP, issues their custom code, and
-- preloads bonus credits.
CREATE OR REPLACE FUNCTION public.admin_create_vip(
  p_user_id uuid,
  p_custom_code text,
  p_rake_share_pct numeric,
  p_preload_bonus numeric
)
RETURNS TABLE (
  ok boolean,
  message text,
  code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_code text;
  v_existing_code text;
BEGIN
  IF p_user_id IS NULL OR p_custom_code IS NULL OR length(trim(p_custom_code)) < 3 THEN
    RETURN QUERY SELECT false, 'invalid_input'::text, NULL::text;
    RETURN;
  END IF;
  IF p_rake_share_pct < 0 OR p_rake_share_pct > 50 THEN
    RETURN QUERY SELECT false, 'rake_share_out_of_range'::text, NULL::text;
    RETURN;
  END IF;

  v_clean_code := upper(regexp_replace(trim(p_custom_code), '[^A-Z0-9]', '', 'g'));
  IF length(v_clean_code) < 3 OR length(v_clean_code) > 20 THEN
    RETURN QUERY SELECT false, 'code_length'::text, NULL::text;
    RETURN;
  END IF;

  -- Check the code isn't taken by someone else
  SELECT code INTO v_existing_code
  FROM public.referral_codes
  WHERE upper(code) = v_clean_code AND owner_user_id <> p_user_id;
  IF v_existing_code IS NOT NULL THEN
    RETURN QUERY SELECT false, 'code_taken'::text, NULL::text;
    RETURN;
  END IF;

  -- Promote user
  UPDATE public.users
    SET is_vip = true,
        bonus_balance = COALESCE(bonus_balance, 0) + COALESCE(p_preload_bonus, 0)
  WHERE id = p_user_id;

  -- Issue the VIP code (or repurpose an existing one with the same string)
  INSERT INTO public.referral_codes (code, owner_user_id, is_vip_code, rake_share_pct, is_active)
  VALUES (v_clean_code, p_user_id, true, p_rake_share_pct, true)
  ON CONFLICT (code) DO UPDATE
    SET is_vip_code = true,
        rake_share_pct = EXCLUDED.rake_share_pct,
        is_active = true
  RETURNING code INTO v_existing_code;

  RETURN QUERY SELECT true, 'ok'::text, v_existing_code;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_vip(uuid, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_vip(uuid, text, numeric, numeric) TO service_role;

-- 10. AWARD POINTS HELPER ------------------------------------------------
-- Used by /api/bet (volume points) and /api/markets/resolve (win points).
-- Points scale with stake/winnings: 1 pt per ₦250 wagered, 1 pt per ₦100 won.
CREATE OR REPLACE FUNCTION public.award_points(
  p_user_id uuid,
  p_reason text,
  p_points integer,
  p_bet_id uuid,
  p_metadata jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_points = 0 OR p_user_id IS NULL THEN RETURN; END IF;
  UPDATE public.users SET points = points + p_points WHERE id = p_user_id;
  INSERT INTO public.points_log (user_id, reason, points, related_bet_id, metadata)
  VALUES (p_user_id, p_reason, p_points, p_bet_id, p_metadata);
END;
$$;

REVOKE ALL ON FUNCTION public.award_points(uuid, text, integer, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.award_points(uuid, text, integer, uuid, jsonb) TO service_role;

-- 11. PLACE BET — award volume points atomically -------------------------
-- Adds a single line to the existing place_bet RPC: 1 point per ₦250 of
-- gross stake, awarded in the same transaction so points + bet are
-- always consistent.
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

  SELECT tngn_balance, bonus_balance INTO v_real, v_bonus
  FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002'; END IF;

  v_real := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);
  IF v_real + v_bonus < p_stake_tngn THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  v_entry_rake := round(p_stake_tngn * v_entry_rake_pct, 4);
  v_net_stake  := p_stake_tngn - v_entry_rake;
  v_jackpot    := p_stake_tngn >= v_jackpot_min;

  IF v_real >= p_stake_tngn THEN
    v_new_real  := v_real - p_stake_tngn;
    v_new_bonus := v_bonus;
  ELSE
    v_new_real  := 0;
    v_new_bonus := v_bonus - (p_stake_tngn - v_real);
  END IF;

  UPDATE public.users
    SET tngn_balance = v_new_real,
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
    SET total_pool = COALESCE(total_pool, 0) + v_net_stake,
        pool_by_outcome = pool_by_outcome
          || jsonb_build_object(v_pool_key, v_current_pool + v_net_stake)
  WHERE id = p_market_id;

  INSERT INTO public.treasury_log (
    type, amount_tngn, bet_id, user_id, market_id, created_at
  ) VALUES (
    'entry_rake', v_entry_rake, v_bet_id, p_user_id, p_market_id, now()
  );

  -- Volume points: floor(stake / 250). At least 1 point for stakes >= 100.
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

NOTIFY pgrst, 'reload schema';
