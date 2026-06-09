-- Launch Welcome Match: 100% match on a user's first deposit, capped.
--
-- WHY this shape (vs. an unconditional sign-up credit):
--   - Drives real money in: the match only fires on the user's first
--     real deposit. Cost of acquisition is gated by user commitment.
--   - "I won something" feeling: deposit ₦1,000 and your wallet shows
--     ₦2,000. Strong dopamine, capped exposure.
--   - Self-limiting: no slot cap to manage — exposure is bounded by
--     (cutoff date) × (per-user cap) × (whether they deposit).
--
-- Promotional credit lands in bonus_balance (NOT withdrawable until the
-- rollover requirement is met — see Terms §3). So a user who claims the
-- match and never predicts costs us nothing; one who claims and loses
-- the prediction costs us nothing; one who claims and wins withdraws
-- some fraction of the match as cash. Expected real cost per claim is
-- well below face value.
--
-- TO ADJUST after deploy (admin, via SQL):
--   update public.launch_promo set match_cap = 2000;                 -- raise/lower cap
--   update public.launch_promo set min_deposit = 1000;               -- raise min deposit
--   update public.launch_promo set cutoff = '2026-06-20 23:59:59+01';
--   update public.launch_promo set active = false;                   -- kill switch
--   select * from public.launch_promo;

-- ── Clean up older promo shape if it was applied before this migration ──
-- Earlier draft used slots_total / slots_claimed and a claim_launch_bonus()
-- function. Drop both so the new shape lands cleanly.
DROP FUNCTION IF EXISTS public.claim_launch_bonus(uuid);
DROP TABLE    IF EXISTS public.launch_promo_grants;
DROP TABLE    IF EXISTS public.launch_promo;

-- ── Singleton config row ────────────────────────────────────────────────
CREATE TABLE public.launch_promo (
  id          int  PRIMARY KEY DEFAULT 1,
  match_ratio numeric     NOT NULL DEFAULT 1.0,                          -- 1.0 = 100% match
  match_cap   numeric     NOT NULL DEFAULT 1000,                         -- max promo credit per user
  min_deposit numeric     NOT NULL DEFAULT 500,                          -- min first deposit to qualify
  cutoff      timestamptz NOT NULL DEFAULT '2026-06-20 23:59:59+01',     -- offer window end
  active      boolean     NOT NULL DEFAULT true,
  CONSTRAINT launch_promo_single_row CHECK (id = 1)
);

INSERT INTO public.launch_promo (id, match_ratio, match_cap, min_deposit, cutoff, active)
VALUES (1, 1.0, 1000, 500, '2026-06-20 23:59:59+01', true)
ON CONFLICT (id) DO NOTHING;

-- ── Per-user grant ledger (PK = user_id makes this idempotent) ──────────
-- One row per user, ever. Stores both the trigger deposit and the credit
-- so analytics can compute conversion and cost without joining elsewhere.
CREATE TABLE public.launch_promo_grants (
  user_id        uuid        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  deposit_amount numeric     NOT NULL,
  credit_granted numeric     NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.launch_promo        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.launch_promo_grants ENABLE ROW LEVEL SECURITY;
-- No policies → only service_role / SECURITY DEFINER functions can touch these.

-- ── Atomic claim on first deposit ───────────────────────────────────────
-- Returns the credit amount granted (0 if not eligible / already claimed
-- / deposit too small / past cutoff / promo paused). Called from the
-- deposit webhook AFTER tngn_balance has been credited. Safe to call on
-- every deposit; idempotent per user.
CREATE OR REPLACE FUNCTION public.claim_welcome_match(
  p_user_id        uuid,
  p_deposit_amount numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match_ratio numeric;
  v_match_cap   numeric;
  v_min_deposit numeric;
  v_cutoff      timestamptz;
  v_active      boolean;
  v_credit      numeric;
BEGIN
  IF p_deposit_amount IS NULL OR p_deposit_amount <= 0 THEN
    RETURN 0;
  END IF;

  -- Already granted? Nothing to do (idempotent across deposits).
  IF EXISTS (SELECT 1 FROM public.launch_promo_grants WHERE user_id = p_user_id) THEN
    RETURN 0;
  END IF;

  SELECT match_ratio, match_cap, min_deposit, cutoff, active
    INTO v_match_ratio, v_match_cap, v_min_deposit, v_cutoff, v_active
  FROM public.launch_promo
  WHERE id = 1
  FOR UPDATE;

  IF NOT FOUND OR NOT v_active THEN RETURN 0; END IF;
  IF now() > v_cutoff THEN RETURN 0; END IF;
  IF p_deposit_amount < v_min_deposit THEN RETURN 0; END IF;

  -- Credit = min(deposit × ratio, cap). Floor at 0 just in case of a
  -- pathological config (ratio = 0).
  v_credit := LEAST(p_deposit_amount * v_match_ratio, v_match_cap);
  IF v_credit <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.launch_promo_grants (user_id, deposit_amount, credit_granted)
  VALUES (p_user_id, p_deposit_amount, v_credit);

  UPDATE public.users
    SET bonus_balance = COALESCE(bonus_balance, 0) + v_credit
  WHERE id = p_user_id;

  RETURN v_credit;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_welcome_match(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_welcome_match(uuid, numeric) TO service_role;

-- ── Restore the auth-user trigger to its pre-promo shape ────────────────
-- The signup trigger no longer touches promo credit (deposit-gated now).
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
