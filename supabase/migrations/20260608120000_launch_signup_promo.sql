-- Launch sign-up promotion: 500 promotional credits for early users.
--
-- Grants a one-time bonus_balance credit to each new user who signs up
-- before a cutoff, capped at a fixed number of slots. Both guards
-- (cutoff + slot count) are enforced atomically inside claim_launch_bonus
-- under a row lock, so a burst of concurrent sign-ups can never over-grant
-- past the slot cap.
--
-- Promotional credit lands in bonus_balance (NOT withdrawable until the
-- rollover requirement is met — see Terms §3), so this is marketing spend
-- that must be predicted with before it can ever leave as naira.
--
-- TO ADJUST after deploy (admin, via SQL):
--   update public.launch_promo set slots_total = 1000;            -- more slots
--   update public.launch_promo set cutoff = '2026-06-15 23:59:59+01';
--   update public.launch_promo set active = false;                -- kill switch
--   select amount, slots_total, slots_claimed, cutoff, active from public.launch_promo;

-- ── Singleton config row ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.launch_promo (
  id            int PRIMARY KEY DEFAULT 1,
  amount        numeric NOT NULL DEFAULT 500,         -- credits granted per user
  slots_total   int     NOT NULL DEFAULT 500,         -- hard cap on number of grants
  slots_claimed int     NOT NULL DEFAULT 0,
  cutoff        timestamptz NOT NULL DEFAULT '2026-06-12 23:59:59+01',  -- end of Friday (WAT)
  active        boolean NOT NULL DEFAULT true,
  CONSTRAINT launch_promo_single_row CHECK (id = 1)
);

INSERT INTO public.launch_promo (id, amount, slots_total, slots_claimed, cutoff, active)
VALUES (1, 500, 500, 0, '2026-06-12 23:59:59+01', true)
ON CONFLICT (id) DO NOTHING;

-- ── Per-user grant ledger (also enforces idempotency: PK = user_id) ─────
CREATE TABLE IF NOT EXISTS public.launch_promo_grants (
  user_id    uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  amount     numeric NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.launch_promo        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.launch_promo_grants ENABLE ROW LEVEL SECURITY;
-- No policies → only service_role / SECURITY DEFINER functions can touch these.

-- ── Atomic claim ────────────────────────────────────────────────────────
-- Returns the amount granted (0 if not eligible / already claimed / sold out
-- / past cutoff). Safe to call on every sign-up; idempotent per user.
CREATE OR REPLACE FUNCTION public.claim_launch_bonus(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount numeric;
  v_total  int;
  v_claimed int;
  v_cutoff timestamptz;
  v_active boolean;
BEGIN
  -- Already granted? Nothing to do (idempotent).
  IF EXISTS (SELECT 1 FROM public.launch_promo_grants WHERE user_id = p_user_id) THEN
    RETURN 0;
  END IF;

  -- Lock the singleton row so the slot check + increment is atomic.
  SELECT amount, slots_total, slots_claimed, cutoff, active
    INTO v_amount, v_total, v_claimed, v_cutoff, v_active
  FROM public.launch_promo
  WHERE id = 1
  FOR UPDATE;

  IF NOT FOUND OR NOT v_active THEN RETURN 0; END IF;
  IF now() > v_cutoff THEN RETURN 0; END IF;
  IF v_claimed >= v_total THEN RETURN 0; END IF;

  UPDATE public.launch_promo
    SET slots_claimed = slots_claimed + 1
  WHERE id = 1;

  INSERT INTO public.launch_promo_grants (user_id, amount)
  VALUES (p_user_id, v_amount);

  UPDATE public.users
    SET bonus_balance = COALESCE(bonus_balance, 0) + v_amount
  WHERE id = p_user_id;

  RETURN v_amount;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_launch_bonus(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_launch_bonus(uuid) TO service_role;

-- ── Wire into the Supabase-auth sign-up trigger ─────────────────────────
-- (Covers the phone/OTP path, which creates users via auth.users.)
-- Preserves prior behaviour: insert users row + ensure referral code.
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
  PERFORM public.claim_launch_bonus(NEW.id);
  RETURN NEW;
END;
$$;
