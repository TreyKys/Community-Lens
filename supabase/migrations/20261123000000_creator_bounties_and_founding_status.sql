-- ============================================================================
-- Creator program: per-depositor bounties + founding-creator status
-- ============================================================================
-- Why: the existing VIP referral deal pays rake_share_pct (max 50) of a 1.5%
-- entry rake — i.e. at most 0.75% of stake volume, and in practice 20%, so
-- 0.3%. A creator must drive ~₦3.3m of staking to earn ₦10k. Twelve codes
-- were issued on those terms and brought 13 users between them. The tooling
-- was never the problem; the offer was worth nothing.
--
-- This adds a bounty a creator can actually picture: a flat amount per
-- referred user who becomes a REAL user. Rake share is left exactly as is, so
-- the two can run together.
--
-- ── Anti-farm design (this is the part that matters) ───────────────────────
-- Paying on deposit alone is trivially farmable: deposit ₦1,000, collect a
-- ₦1,500 bounty, withdraw the ₦1,000. So a bounty qualifies only when the
-- referred user has BOTH deposited and WAGERED at least the configured
-- minimums. Wagering is where the house edge lives, so a farmer has to put
-- real money through the book to trigger it.
--
-- Further guards:
--   • one bounty per referred user, ever (UNIQUE on referred_user_id)
--   • never self-referral (referrer <> referred)
--   • only codes with deposit_bounty_tngn > 0 pay anything
--   • default is 0, so NOTHING changes for existing codes until an admin
--     deliberately sets a bounty
-- ============================================================================

-- ── 1. Config on the code ──────────────────────────────────────────────────
ALTER TABLE public.referral_codes
  ADD COLUMN IF NOT EXISTS deposit_bounty_tngn numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounty_min_deposit_tngn numeric NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS bounty_min_wagered_tngn numeric NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS is_founding_creator boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.referral_codes.deposit_bounty_tngn IS
  'Flat tNGN paid to the code owner per qualifying referred user. 0 = off.';
COMMENT ON COLUMN public.referral_codes.is_founding_creator IS
  'Founding-creator badge. Cosmetic/status only — carries no payout logic.';

-- ── 2. The bounty ledger (also the idempotency record) ─────────────────────
CREATE TABLE IF NOT EXISTS public.referral_bounties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL,
  referrer_user_id  uuid NOT NULL REFERENCES public.users(id),
  referred_user_id  uuid NOT NULL REFERENCES public.users(id),
  amount_tngn       numeric NOT NULL CHECK (amount_tngn > 0),
  deposited_tngn    numeric NOT NULL,
  wagered_tngn      numeric NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- One bounty per referred user for all time. This is the anti-double-pay
  -- anchor, so it is a constraint and not application logic.
  CONSTRAINT referral_bounties_one_per_referred UNIQUE (referred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_bounties_referrer
  ON public.referral_bounties(referrer_user_id, created_at DESC);

ALTER TABLE public.referral_bounties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Creators can read own bounties" ON public.referral_bounties;
CREATE POLICY "Creators can read own bounties" ON public.referral_bounties
  FOR SELECT USING (auth.uid() = referrer_user_id);

-- ── 3. Award a bounty if (and only if) the referral has qualified ──────────
-- Safe to call at any time, any number of times, for any user. Returns what
-- it did so callers can log it. Never raises on "not qualified" — that is a
-- normal answer, not an error.
CREATE OR REPLACE FUNCTION public.award_referral_bounty(p_referred_user_id uuid)
RETURNS TABLE (awarded boolean, reason text, amount_tngn numeric, referrer_user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      public.users%ROWTYPE;
  v_code      public.referral_codes%ROWTYPE;
  v_deposited numeric;
  v_wagered   numeric;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_referred_user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'user_not_found',0::numeric,NULL::uuid; RETURN;
  END IF;

  IF v_user.referred_by_user_id IS NULL THEN
    RETURN QUERY SELECT false,'not_referred',0::numeric,NULL::uuid; RETURN;
  END IF;

  -- Self-referral can never pay.
  IF v_user.referred_by_user_id = p_referred_user_id THEN
    RETURN QUERY SELECT false,'self_referral',0::numeric,NULL::uuid; RETURN;
  END IF;

  -- Already paid for this user? The UNIQUE constraint is the real guard;
  -- this is just the cheap early exit.
  IF EXISTS (SELECT 1 FROM public.referral_bounties WHERE referred_user_id = p_referred_user_id) THEN
    RETURN QUERY SELECT false,'already_awarded',0::numeric,v_user.referred_by_user_id; RETURN;
  END IF;

  -- The code that brought them, and whether it carries a bounty at all.
  SELECT * INTO v_code FROM public.referral_codes
   WHERE owner_user_id = v_user.referred_by_user_id AND is_active
   ORDER BY deposit_bounty_tngn DESC
   LIMIT 1;
  IF NOT FOUND OR COALESCE(v_code.deposit_bounty_tngn,0) <= 0 THEN
    RETURN QUERY SELECT false,'no_bounty_on_code',0::numeric,v_user.referred_by_user_id; RETURN;
  END IF;

  -- Qualification: real money in, AND real money staked.
  SELECT COALESCE(SUM(amount_ngn),0) INTO v_deposited
    FROM public.squad_transactions
   WHERE user_id = p_referred_user_id AND status = 'completed';

  SELECT COALESCE((SELECT SUM(stake_tngn) FROM public.user_bets WHERE user_id = p_referred_user_id),0)
       + COALESCE((SELECT SUM(slip_stake_tngn) FROM public.multiplier_slips WHERE user_id = p_referred_user_id),0)
    INTO v_wagered;

  IF v_deposited < v_code.bounty_min_deposit_tngn THEN
    RETURN QUERY SELECT false,'deposit_below_min',0::numeric,v_user.referred_by_user_id; RETURN;
  END IF;
  IF v_wagered < v_code.bounty_min_wagered_tngn THEN
    RETURN QUERY SELECT false,'wagered_below_min',0::numeric,v_user.referred_by_user_id; RETURN;
  END IF;

  -- Qualified. Record first: the UNIQUE constraint makes the insert the
  -- thing that decides, so two concurrent callers cannot both pay.
  BEGIN
    INSERT INTO public.referral_bounties
      (code, referrer_user_id, referred_user_id, amount_tngn, deposited_tngn, wagered_tngn)
    VALUES
      (v_code.code, v_user.referred_by_user_id, p_referred_user_id,
       v_code.deposit_bounty_tngn, v_deposited, v_wagered);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false,'already_awarded',0::numeric,v_user.referred_by_user_id; RETURN;
  END;

  -- Then pay. Withdrawable cash on purpose: a bonus-balance "bounty" is not
  -- an incentive anyone with an audience would work for.
  PERFORM public.credit_user(v_user.referred_by_user_id, v_code.deposit_bounty_tngn, 0);

  RETURN QUERY SELECT true,'awarded',v_code.deposit_bounty_tngn,v_user.referred_by_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.award_referral_bounty(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_referral_bounty(uuid) TO service_role;

-- ── 4. Sweep: award any referral that has newly qualified ──────────────────
-- Called from the 15-minute cron. Deliberately NOT wired into the bet or
-- deposit hot paths — money-moving code does not belong in the middle of a
-- user's placement flow, and a bounty is in no hurry.
CREATE OR REPLACE FUNCTION public.sweep_referral_bounties(p_limit integer DEFAULT 200)
RETURNS TABLE (checked integer, awarded integer, paid_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     record;
  v_res     record;
  v_checked integer := 0;
  v_awarded integer := 0;
  v_paid    numeric := 0;
BEGIN
  FOR v_row IN
    SELECT u.id
      FROM public.users u
     WHERE u.referred_by_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.referral_bounties b WHERE b.referred_user_id = u.id)
       AND EXISTS (SELECT 1 FROM public.squad_transactions s
                    WHERE s.user_id = u.id AND s.status = 'completed')
     LIMIT p_limit
  LOOP
    v_checked := v_checked + 1;
    SELECT * INTO v_res FROM public.award_referral_bounty(v_row.id);
    IF v_res.awarded THEN
      v_awarded := v_awarded + 1;
      v_paid := v_paid + v_res.amount_tngn;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_checked, v_awarded, v_paid;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_referral_bounties(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_referral_bounties(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
