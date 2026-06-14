-- Double-sided normal referrals.
--
-- Until now, only VIP codes carried a signup bonus for the *referred*
-- user (signup_bonus_tngn, added in 20260611100000). Normal codes paid
-- only the referrer (₦200 + 200 points), giving the friend who clicked
-- the link no immediate reason to follow through with the redeem.
--
-- This migration mirrors the VIP pattern on normal codes:
--   • Backfill every existing normal code with signup_bonus_tngn = 200.
--   • Update ensure_user_referral_code() so new normal codes ship with
--     the same default.
--
-- The redeem_referral_code() function already credits any positive
-- signup_bonus_tngn to the redeeming user (regardless of code type) and
-- logs a treasury_log row — so no changes to the redeem path are
-- needed. Once this lands, every existing and future normal code is
-- automatically double-sided.
--
-- WHY ₦200 (and not ₦500 like VIP default):
--   • Symmetric with what the referrer gets — keeps the offer feeling
--     "give 200, get 200" rather than asymmetric.
--   • Bounded liability: a normal user spamming their code costs us
--     ₦200/redeem in bonus_balance, which is bet-only and rarely
--     withdraws as cash after rollover. VIP codes are admin-curated and
--     warrant a larger hook.
--
-- TUNING after deploy (admin SQL):
--   update public.referral_codes set signup_bonus_tngn = 500
--     where is_vip_code = false;                     -- raise across the board
--   update public.referral_codes set signup_bonus_tngn = 0
--     where code = 'ABUSER';                         -- kill a specific code

-- 1. Backfill every existing normal code to the new default.
UPDATE public.referral_codes
   SET signup_bonus_tngn = 200
 WHERE is_vip_code = false
   AND signup_bonus_tngn = 0;

-- 2. New normal codes minted at signup should ship with the same default.
--    Only the INSERT inside the retry loop changes — the rest of the
--    function is identical to the version in 20240614000000.
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

  v_seed := upper(replace(p_user_id::text, '-', ''));
  FOR i IN 1..5 LOOP
    IF i = 1 THEN
      v_attempt := substr(v_seed, 1, 6);
    ELSE
      v_attempt := substr(v_seed, 1, 4) || upper(substr(md5(random()::text), 1, 2));
    END IF;
    BEGIN
      INSERT INTO public.referral_codes (
        code, owner_user_id, is_vip_code, rake_share_pct, signup_bonus_tngn
      )
      VALUES (v_attempt, p_user_id, false, 0, 200)
      RETURNING code INTO v_existing;
      RETURN v_existing;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;
  RAISE EXCEPTION 'could_not_generate_referral_code';
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_user_referral_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_user_referral_code(uuid) TO service_role;
