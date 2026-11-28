-- ============================================================================
-- A reward for playing The Run
-- ============================================================================
-- The existing catalogue is all STATED claims — "follow us on X", paid on an
-- assertion nobody can verify, which is why they are capped at N100 each.
-- This one is different: whether somebody has entered a Run is a fact in the
-- database, so it is checked rather than taken on trust. That makes it worth
-- more than a follow, and it pays for the behaviour actually wanted — trying
-- the new product once.
--
-- Pays into BONUS balance like every other profile reward, so the money has
-- to be played through rather than withdrawn straight back out. For a brand
-- new product that is the right shape: it buys a first go, not a cash-out.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reward_catalogue()
RETURNS TABLE (reward_id text, label text, detail text,
               reward_tngn numeric, needs_handle boolean, url text)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT * FROM (VALUES
    -- PAYS NOTHING. It used to pay ₦200 on verification, but there is no SMS
    -- provider, so verification could never happen and the money could never
    -- be paid. A reward that cannot pay out is not a reward, it is a debt the
    -- product quietly accrues against itself. The number is still collected —
    -- it is worth having for account recovery — but nothing is promised for it.
    ('phone',      'Add your phone number',
     'For account recovery and keeping withdrawals secure',       0::numeric, false, NULL::text),
    -- Earned, not stated: gated on an actual run_entries row in
    -- claim_profile_reward, so it cannot be claimed by anyone who has not played.
    ('first_run',  'Play your first Run',
     'Five fixtures, one stake — call them and watch it grow',  300::numeric, false, '/runs'),
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

-- Same function as live, with the earned-reward gate added.
CREATE OR REPLACE FUNCTION public.claim_profile_reward(p_user_id uuid, p_reward_id text, p_handle text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS TABLE(applied boolean, reason text, status text, reward_tngn numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- Terminal immediately. There is no money on this any more, so there is
    -- nothing to hold back pending a verification that cannot happen.
    v_status := 'paid';
  ELSE
    IF c.needs_handle AND (p_handle IS NULL OR length(btrim(p_handle)) < 2) THEN
      RETURN QUERY SELECT false, 'Enter the handle you follow from', NULL::text, 0::numeric;
      RETURN;
    END IF;

    -- Earned rewards, as opposed to stated ones. The follow-us rewards pay on
    -- an assertion nobody can check; this one is checkable, so it is checked.
    -- Without the gate 'first_run' is just free money for tapping a button.
    IF p_reward_id = 'first_run' THEN
      IF NOT EXISTS (SELECT 1 FROM public.run_entries WHERE user_id = p_user_id) THEN
        RETURN QUERY SELECT false,
          'Enter a Run first, then come back and claim this',
          NULL::text, 0::numeric;
        RETURN;
      END IF;
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

  -- The `> 0` guard is the whole point of this migration reaching in here: a
  -- zero-value reward must not credit ₦0, write a ₦0 treasury row, or send
  -- somebody a notification reading "₦0 bonus added".
  IF v_status = 'paid' AND c.reward_tngn > 0 THEN
    PERFORM public.credit_user(p_user_id, 0, c.reward_tngn);
    INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
    VALUES ('profile_reward', -c.reward_tngn, p_user_id,
            jsonb_build_object('reward_id', p_reward_id, 'handle', p_handle));
    INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
    VALUES (p_user_id, 'profile_reward',
            '₦' || to_char(c.reward_tngn, 'FM999,999') || ' bonus added — ' || c.label,
            c.reward_tngn, 'success', '/profile');
    RETURN QUERY SELECT true, 'paid', 'paid'::text, c.reward_tngn;
  ELSIF v_status = 'paid' THEN
    -- Recorded, nothing owed. Without this branch a zero-value reward would
    -- fall through to the pending path and report itself as money being held.
    RETURN QUERY SELECT true, 'saved', 'paid'::text, 0::numeric;
  ELSE
    RETURN QUERY SELECT true, 'pending', 'pending'::text, c.reward_tngn;
  END IF;
END;
$function$;

NOTIFY pgrst, 'reload schema';
