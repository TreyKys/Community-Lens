-- Profile rewards: phone number and social follows.
--
-- Two goals that are NOT the same: collecting phone numbers (real business
-- value — contactability, KYC, and the cheapest possible brake on
-- multi-accounting) and growing the social accounts (goodwill, unmeasurable).
-- They are priced differently on purpose.
--
-- WHAT CAN ACTUALLY BE VERIFIED, TODAY:
--
--   phone   — verifiable in principle (Termii OTP exists in this codebase),
--             but the integration is currently returning 401. So the number
--             is COLLECTED immediately and the reward is held PENDING until a
--             verification actually happens. That gets the numbers now without
--             paying for data nobody has checked.
--   socials — not verifiable at all. Neither X nor Instagram exposes "did
--             user A follow account B" for arbitrary users, and the X API
--             here is metered and expensive. A follow claim is therefore a
--             STATED claim, and priced accordingly.
--
-- Everything pays BONUS credit, never cash. Bonus is non-withdrawable and must
-- be staked, so the worst case on a farmed claim is promotional credit that
-- largely returns to the product rather than naira out of the door.

-- ── One account per phone number ───────────────────────────────────────────
-- Worth having regardless of any reward. It is the single cheapest barrier to
-- someone signing up ten times, and it costs nothing to enforce.
--
-- Partial: NULL phones do not collide with each other, so existing accounts
-- without a number are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON public.users (phone) WHERE phone IS NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

-- ── Reward claims ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profile_rewards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reward_id    text NOT NULL,
  -- 'pending'  — claimed but not yet payable (phone awaiting verification)
  -- 'paid'     — credited
  -- 'revoked'  — an admin found it false and clawed it back
  status       text NOT NULL DEFAULT 'paid'
                 CHECK (status IN ('pending', 'paid', 'revoked')),
  reward_tngn  numeric NOT NULL CHECK (reward_tngn >= 0),
  -- The handle the user stated, for the social rewards. This is the whole
  -- audit trail: nothing can check it automatically, so the least that can be
  -- done is record what was asserted and by whom.
  handle       text,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES public.users(id),
  revoke_note  text,
  -- One claim per reward per user, forever. This is the guard that actually
  -- stops double payment — not the check in the function above it.
  UNIQUE (user_id, reward_id)
);

CREATE INDEX IF NOT EXISTS profile_rewards_user_idx
  ON public.profile_rewards (user_id);
CREATE INDEX IF NOT EXISTS profile_rewards_pending_idx
  ON public.profile_rewards (status) WHERE status = 'pending';

ALTER TABLE public.profile_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_rewards_owner_read ON public.profile_rewards;
CREATE POLICY profile_rewards_owner_read ON public.profile_rewards
  FOR SELECT USING (auth.uid() = user_id);

-- ── The catalogue, in one place ────────────────────────────────────────────
-- A function rather than a table: these change with marketing, not with data,
-- and keeping them here means the API and the UI cannot disagree about what a
-- reward is worth.
CREATE OR REPLACE FUNCTION public.reward_catalogue()
RETURNS TABLE (reward_id text, label text, detail text, reward_tngn numeric,
               needs_handle boolean, url text)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT * FROM (VALUES
    -- Verifiable, and genuinely useful to the business, so it pays double.
    ('phone',      'Add your phone number',
     'We''ll text you when a market you''re in resolves',       200::numeric, false, NULL::text),
    -- Stated claims. ₦100 each: four of them is ₦400, which is a sensible
    -- ceiling on money handed out against an assertion nobody can check.
    ('x_opinions', 'Follow Opinions.ng on X',
     'Enter your @handle so we can check',                      100::numeric, true,  'https://x.com/opinions_ng'),
    ('ig_opinions','Follow Opinions.ng on Instagram',
     'Enter your @handle so we can check',                      100::numeric, true,  'https://instagram.com/opinions.ng'),
    ('x_neuro',    'Follow NeuroDev Labs on X',
     'Enter your @handle so we can check',                      100::numeric, true,  'https://x.com/neurodevlabs'),
    ('ig_neuro',   'Follow NeuroDev Labs on Instagram',
     'Enter your @handle so we can check',                      100::numeric, true,  'https://instagram.com/neurodevlabs')
  ) AS t(reward_id, label, detail, reward_tngn, needs_handle, url);
$$;

-- ── State for one user ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_reward_state(p_user_id uuid)
RETURNS TABLE (reward_id text, label text, detail text, reward_tngn numeric,
               needs_handle boolean, url text, status text, handle text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.reward_id, c.label, c.detail, c.reward_tngn, c.needs_handle, c.url,
         COALESCE(r.status, 'available') AS status,
         r.handle
    FROM public.reward_catalogue() c
    LEFT JOIN public.profile_rewards r
      ON r.reward_id = c.reward_id AND r.user_id = p_user_id;
$$;

-- ── Claim ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_profile_reward(
  p_user_id   uuid,
  p_reward_id text,
  p_handle    text DEFAULT NULL,
  p_phone     text DEFAULT NULL
)
RETURNS TABLE (applied boolean, reason text, status text, reward_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c        record;
  v_user   public.users%ROWTYPE;
  v_status text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Sign in first', NULL::text, 0::numeric; RETURN;
  END IF;

  SELECT * INTO c FROM public.reward_catalogue() WHERE reward_id = p_reward_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Unknown reward', NULL::text, 0::numeric; RETURN;
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'No such account', NULL::text, 0::numeric; RETURN;
  END IF;

  -- ── phone ───────────────────────────────────────────────────────────────
  IF p_reward_id = 'phone' THEN
    IF p_phone IS NULL OR length(btrim(p_phone)) < 10 THEN
      RETURN QUERY SELECT false, 'Enter a valid phone number', NULL::text, 0::numeric; RETURN;
    END IF;

    BEGIN
      UPDATE public.users SET phone = btrim(p_phone) WHERE id = p_user_id;
    EXCEPTION WHEN unique_violation THEN
      -- Deliberately does not say whether the number exists — that would turn
      -- this into an oracle for "is this person a user here", which on a
      -- gambling platform is a privacy problem, not just a leak.
      RETURN QUERY SELECT false, 'That number cannot be used on this account',
                          NULL::text, 0::numeric;
      RETURN;
    END;

    -- PENDING until a verification actually happens. Paying now would be
    -- paying for a string somebody typed.
    v_status := CASE WHEN v_user.phone_verified_at IS NOT NULL THEN 'paid' ELSE 'pending' END;
  ELSE
    IF c.needs_handle AND (p_handle IS NULL OR length(btrim(p_handle)) < 2) THEN
      RETURN QUERY SELECT false, 'Enter the handle you follow from', NULL::text, 0::numeric;
      RETURN;
    END IF;
    v_status := 'paid';
  END IF;

  -- UNIQUE(user_id, reward_id) is the real guard: two taps both pass the read
  -- above and only one insert can win.
  BEGIN
    INSERT INTO public.profile_rewards
      (user_id, reward_id, status, reward_tngn, handle, paid_at)
    VALUES (p_user_id, p_reward_id, v_status, c.reward_tngn,
            NULLIF(btrim(COALESCE(p_handle,'')), ''),
            CASE WHEN v_status = 'paid' THEN now() ELSE NULL END);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, 'Already claimed', NULL::text, 0::numeric; RETURN;
  END;

  IF v_status = 'paid' THEN
    PERFORM public.credit_user(p_user_id, 0, c.reward_tngn);
    INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
    VALUES ('profile_reward', -c.reward_tngn, p_user_id,
            jsonb_build_object('reward_id', p_reward_id, 'handle', p_handle));
    INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
    VALUES (p_user_id, 'profile_reward',
            '₦' || to_char(c.reward_tngn, 'FM999,999') || ' bonus added — ' || c.label,
            c.reward_tngn, 'success', '/profile');
    RETURN QUERY SELECT true, 'paid', 'paid'::text, c.reward_tngn;
  ELSE
    RETURN QUERY SELECT true, 'pending', 'pending'::text, c.reward_tngn;
  END IF;
END;
$$;

-- ── Release a pending phone reward once the number is verified ─────────────
-- Called by the OTP verify path. Separate from claiming so the reward can be
-- claimed today and paid whenever verification starts working.
CREATE OR REPLACE FUNCTION public.release_verified_phone_reward(p_user_id uuid)
RETURNS TABLE (applied boolean, reward_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record;
BEGIN
  UPDATE public.users
     SET phone_verified_at = COALESCE(phone_verified_at, now())
   WHERE id = p_user_id;

  SELECT * INTO r FROM public.profile_rewards
   WHERE user_id = p_user_id AND reward_id = 'phone' AND status = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::numeric; RETURN;
  END IF;

  UPDATE public.profile_rewards
     SET status = 'paid', paid_at = now()
   WHERE id = r.id;

  PERFORM public.credit_user(p_user_id, 0, r.reward_tngn);

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
  VALUES ('profile_reward', -r.reward_tngn, p_user_id,
          jsonb_build_object('reward_id', 'phone', 'released_on_verify', true));

  INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
  VALUES (p_user_id, 'profile_reward',
          'Number verified — ₦' || to_char(r.reward_tngn, 'FM999,999') || ' bonus added',
          r.reward_tngn, 'success', '/dashboard');

  RETURN QUERY SELECT true, r.reward_tngn;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_profile_reward(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_profile_reward(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.get_reward_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reward_state(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.release_verified_phone_reward(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_verified_phone_reward(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
