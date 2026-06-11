-- VIP referral signup bonus.
--
-- Until now, only the referrer was rewarded when someone used a code
-- (points + bonus credit for normal codes; points-only for VIPs). The
-- *referred* user got nothing, which gave new users no specific reason
-- to use a VIP's code vs. a random friend's code.
--
-- This migration adds a per-code "signup_bonus_tngn" knob. When a new
-- user redeems a code with a positive signup bonus, that amount is
-- credited to their bonus_balance (non-withdrawable until rollover
-- requirements are met — same wallet bucket as the Welcome Match).
--
-- WHY per-code (vs. a global VIP_SIGNUP_BONUS constant):
--   - Different VIPs are different scales. Letting each one pitch their
--     own bonus turns the referral code into a real marketing lever.
--   - Lets admin tune individual codes without redeploys.
--
-- WHY default to 500 (not 1000):
--   - Welcome Match already covers up to ₦1,000 on first deposit.
--     Stacking ₦1,000 free on top would change the unit economics.
--     ₦500 feels meaningful (enough for several minimum-stake bets)
--     without doubling the new-user CAC.
--
-- TUNING after deploy (admin SQL):
--   update public.referral_codes set signup_bonus_tngn = 1000
--     where code = 'BIGVIP';
--   update public.referral_codes set signup_bonus_tngn = 0
--     where owner_user_id = '<uid>';      -- kill an over-generous code

ALTER TABLE public.referral_codes
  ADD COLUMN IF NOT EXISTS signup_bonus_tngn numeric NOT NULL DEFAULT 0
    CHECK (signup_bonus_tngn >= 0 AND signup_bonus_tngn <= 5000);

-- Backfill every existing VIP code to the new default so the feature is
-- live for current VIPs the moment the migration runs.
UPDATE public.referral_codes
   SET signup_bonus_tngn = 500
 WHERE is_vip_code = true
   AND signup_bonus_tngn = 0;

-- ── Update admin_create_vip so new VIPs get the bonus baked in ─────────
-- The previous signature took p_rake_share_pct only. We extend it with
-- an optional p_signup_bonus_tngn (default 500). The old shape stays
-- intact so existing callers don't break.
CREATE OR REPLACE FUNCTION public.admin_create_vip(
  p_user_id            uuid,
  p_code               text,
  p_rake_share_pct     numeric,
  p_signup_bonus_tngn  numeric DEFAULT 500
)
RETURNS TABLE (
  ok            boolean,
  message       text,
  code          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_code text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'invalid_input'::text, NULL::text; RETURN;
  END IF;
  IF p_rake_share_pct < 0 OR p_rake_share_pct > 50 THEN
    RETURN QUERY SELECT false, 'rake_share_out_of_range'::text, NULL::text; RETURN;
  END IF;
  IF p_signup_bonus_tngn < 0 OR p_signup_bonus_tngn > 5000 THEN
    RETURN QUERY SELECT false, 'signup_bonus_out_of_range'::text, NULL::text; RETURN;
  END IF;

  v_clean_code := upper(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g'));
  IF length(v_clean_code) < 3 OR length(v_clean_code) > 32 THEN
    RETURN QUERY SELECT false, 'code_length_invalid'::text, NULL::text; RETURN;
  END IF;

  UPDATE public.users SET is_vip = true WHERE id = p_user_id;

  INSERT INTO public.referral_codes (
    code, owner_user_id, is_vip_code, rake_share_pct, signup_bonus_tngn, is_active
  ) VALUES (
    v_clean_code, p_user_id, true, p_rake_share_pct, p_signup_bonus_tngn, true
  )
  ON CONFLICT (code) DO UPDATE
    SET is_vip_code        = true,
        rake_share_pct     = EXCLUDED.rake_share_pct,
        signup_bonus_tngn  = EXCLUDED.signup_bonus_tngn,
        is_active          = true;

  RETURN QUERY SELECT true, 'ok'::text, v_clean_code;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_vip(uuid, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_vip(uuid, text, numeric, numeric) TO service_role;

-- ── Update redeem_referral_code to credit the new user ─────────────────
-- Adds the signup-bonus credit step. Returns the granted amount as a
-- 5th column so the API can surface it in the welcome toast.
CREATE OR REPLACE FUNCTION public.redeem_referral_code(
  p_user_id uuid,
  p_code text
)
RETURNS TABLE (
  ok                  boolean,
  message             text,
  owner_id            uuid,
  is_vip_code         boolean,
  signup_bonus_tngn   numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_row record;
  v_already_referred uuid;
  v_bonus numeric;
BEGIN
  IF p_user_id IS NULL OR p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RETURN QUERY SELECT false, 'invalid_input'::text, NULL::uuid, false, 0::numeric;
    RETURN;
  END IF;

  -- Idempotency: existing referrer = silent success, no bonus re-grant.
  SELECT referred_by_user_id INTO v_already_referred
  FROM public.users WHERE id = p_user_id;

  IF v_already_referred IS NOT NULL THEN
    RETURN QUERY SELECT true, 'already_redeemed'::text, v_already_referred, false, 0::numeric;
    RETURN;
  END IF;

  SELECT rc.id, rc.code, rc.owner_user_id, rc.is_vip_code, rc.is_active, rc.signup_bonus_tngn
    INTO v_code_row
  FROM public.referral_codes rc
  WHERE upper(rc.code) = upper(trim(p_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'code_not_found'::text, NULL::uuid, false, 0::numeric;
    RETURN;
  END IF;

  IF NOT v_code_row.is_active THEN
    RETURN QUERY SELECT false, 'code_inactive'::text, NULL::uuid, false, 0::numeric;
    RETURN;
  END IF;

  IF v_code_row.owner_user_id = p_user_id THEN
    RETURN QUERY SELECT false, 'self_referral'::text, NULL::uuid, false, 0::numeric;
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

  -- Reward the referrer (unchanged from prior version).
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

  -- NEW: reward the referred user with the code's signup bonus.
  -- Bonus_balance bucket (non-withdrawable until rollover — same rules
  -- as the Welcome Match) so we keep our liability bounded.
  v_bonus := COALESCE(v_code_row.signup_bonus_tngn, 0);
  IF v_bonus > 0 THEN
    UPDATE public.users
      SET bonus_balance = COALESCE(bonus_balance, 0) + v_bonus
    WHERE id = p_user_id;

    -- treasury_log row so the bonus shows up in the admin Wallet panel
    -- under a recognisable type. Mirrors the welcome_match pattern.
    INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
    VALUES (
      'referral_signup_bonus',
      v_bonus,
      p_user_id,
      jsonb_build_object('referral_code', v_code_row.code, 'referrer_id', v_code_row.owner_user_id)
    );
  END IF;

  RETURN QUERY SELECT true, 'ok'::text, v_code_row.owner_user_id, v_code_row.is_vip_code, v_bonus;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_referral_code(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_referral_code(uuid, text) TO service_role;
