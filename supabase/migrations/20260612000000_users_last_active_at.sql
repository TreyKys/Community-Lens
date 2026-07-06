-- Real `last_active_at` on users.
--
-- The admin Users panel previously used users.created_at as a stand-in
-- for "last active", which sorted brand-new accounts above repeat users
-- — useless for spotting dormant whales or live activity bursts.
--
-- This migration adds a real column and wires it up via triggers so any
-- meaningful user action (placed a bet, money moved in or out, accepted
-- terms) refreshes the timestamp. App code stays untouched — the DB
-- handles it transparently.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

-- Backfill: every existing user's most recent observable activity.
-- We take the latest of (created_at, last bet placed_at, last
-- treasury_log entry). One-time pass on the migration; the triggers
-- below keep it current from here on.
WITH last_bet AS (
  SELECT user_id, max(placed_at) AS at FROM public.user_bets GROUP BY user_id
),
last_treasury AS (
  SELECT user_id, max(created_at) AS at FROM public.treasury_log
   WHERE user_id IS NOT NULL GROUP BY user_id
)
UPDATE public.users u
   SET last_active_at = GREATEST(
     u.created_at,
     COALESCE((SELECT at FROM last_bet      WHERE user_id = u.id), u.created_at),
     COALESCE((SELECT at FROM last_treasury WHERE user_id = u.id), u.created_at)
   )
 WHERE u.last_active_at IS NULL;

-- Index — admin list sorts by this column frequently.
CREATE INDEX IF NOT EXISTS idx_users_last_active_at
  ON public.users (last_active_at DESC NULLS LAST);

-- Shared bump function. SECURITY DEFINER so it can update users from
-- trigger contexts without needing extra privileges. UPDATE only if the
-- new timestamp is actually newer, so a backfilled timestamp doesn't get
-- regressed by a slow-firing trigger on an old row.
CREATE OR REPLACE FUNCTION public.bump_last_active_at(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  UPDATE public.users
     SET last_active_at = now()
   WHERE id = p_user_id
     AND (last_active_at IS NULL OR last_active_at < now());
END;
$$;

-- Trigger fn: user_bets INSERT → bump the bettor.
CREATE OR REPLACE FUNCTION public.trg_bump_last_active_from_user_bets()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  PERFORM public.bump_last_active_at(NEW.user_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_bets_last_active ON public.user_bets;
CREATE TRIGGER trg_user_bets_last_active
  AFTER INSERT ON public.user_bets
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_last_active_from_user_bets();

-- Trigger fn: treasury_log INSERT → bump the user the row references.
-- Catches deposits, withdrawals, manual credits, welcome match grants,
-- referral signup bonuses, rake events — basically every money signal.
CREATE OR REPLACE FUNCTION public.trg_bump_last_active_from_treasury_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  PERFORM public.bump_last_active_at(NEW.user_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_treasury_log_last_active ON public.treasury_log;
CREATE TRIGGER trg_treasury_log_last_active
  AFTER INSERT ON public.treasury_log
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_last_active_from_treasury_log();

-- Trigger fn: terms_acceptance_log INSERT → bump on sign-up / re-accept.
-- This is what catches "logged in today but didn't bet" activity.
CREATE OR REPLACE FUNCTION public.trg_bump_last_active_from_terms()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  PERFORM public.bump_last_active_at(NEW.user_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_terms_acceptance_last_active ON public.terms_acceptance_log;
CREATE TRIGGER trg_terms_acceptance_last_active
  AFTER INSERT ON public.terms_acceptance_log
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_last_active_from_terms();
