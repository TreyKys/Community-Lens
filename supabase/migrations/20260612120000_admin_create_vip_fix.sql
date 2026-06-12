-- Fix admin_create_vip silent failure + restore the VIP preload bonus.
--
-- Background: migration 20260611100000 added per-code signup bonuses
-- but accidentally:
--   1. Renamed p_custom_code → p_code (breaks existing API caller in
--      /api/admin/vip/create which still sends p_custom_code).
--   2. Dropped p_preload_bonus entirely. That was a separate, semantically
--      different parameter — it credited the VIP's own bonus_balance as a
--      thank-you for being promoted. NEW signup_bonus_tngn is for the
--      *new users* who later redeem the code. Different rewards, both
--      needed.
--
-- This migration restores both as distinct parameters, with the original
-- argument names so the existing API call works without code changes,
-- and adds p_signup_bonus_tngn as a new optional 5th argument.

DROP FUNCTION IF EXISTS public.admin_create_vip(uuid, text, numeric);
DROP FUNCTION IF EXISTS public.admin_create_vip(uuid, text, numeric, numeric);

CREATE OR REPLACE FUNCTION public.admin_create_vip(
  p_user_id            uuid,
  p_custom_code        text,
  p_rake_share_pct     numeric,
  p_preload_bonus      numeric DEFAULT 0,
  p_signup_bonus_tngn  numeric DEFAULT 500
)
RETURNS TABLE (
  ok      boolean,
  message text,
  code    text
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
  IF p_preload_bonus < 0 OR p_preload_bonus > 1000000 THEN
    RETURN QUERY SELECT false, 'preload_bonus_out_of_range'::text, NULL::text; RETURN;
  END IF;
  IF p_signup_bonus_tngn < 0 OR p_signup_bonus_tngn > 5000 THEN
    RETURN QUERY SELECT false, 'signup_bonus_out_of_range'::text, NULL::text; RETURN;
  END IF;

  v_clean_code := upper(regexp_replace(trim(coalesce(p_custom_code, '')), '\s+', '', 'g'));
  IF length(v_clean_code) < 3 OR length(v_clean_code) > 32 THEN
    RETURN QUERY SELECT false, 'code_length_invalid'::text, NULL::text; RETURN;
  END IF;

  -- Flip the VIP flag + apply the personal preload bonus to the VIP's
  -- own bonus_balance. This is the thank-you-for-joining credit, not
  -- the signup bonus their referees will get.
  UPDATE public.users
     SET is_vip = true,
         bonus_balance = COALESCE(bonus_balance, 0) + COALESCE(p_preload_bonus, 0)
   WHERE id = p_user_id;

  -- Issue / repurpose the VIP code. signup_bonus_tngn is the amount
  -- that future new users will receive when they redeem this code.
  INSERT INTO public.referral_codes (
    code, owner_user_id, is_vip_code, rake_share_pct, signup_bonus_tngn, is_active
  ) VALUES (
    v_clean_code, p_user_id, true, p_rake_share_pct, p_signup_bonus_tngn, true
  )
  ON CONFLICT (code) DO UPDATE
    SET is_vip_code        = true,
        owner_user_id      = EXCLUDED.owner_user_id,
        rake_share_pct     = EXCLUDED.rake_share_pct,
        signup_bonus_tngn  = EXCLUDED.signup_bonus_tngn,
        is_active          = true;

  -- Audit row in treasury_log for the personal preload, so the credit
  -- shows up in the admin Wallet panel and the user's forensic drawer.
  IF COALESCE(p_preload_bonus, 0) > 0 THEN
    INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
    VALUES (
      'vip_preload_bonus',
      p_preload_bonus,
      p_user_id,
      jsonb_build_object('code', v_clean_code, 'rake_share_pct', p_rake_share_pct)
    );
  END IF;

  RETURN QUERY SELECT true, 'ok'::text, v_clean_code;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_vip(uuid, text, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_vip(uuid, text, numeric, numeric, numeric) TO service_role;
