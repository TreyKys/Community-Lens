-- Web push.
--
-- In-app notifications only reach someone who is already in the app, which is
-- exactly the person who did not need reminding. "You won ₦4,200" is worth
-- something as a phone notification and almost nothing as a badge they will
-- see next Tuesday.
--
-- Standard Web Push (VAPID), not FCM. firebase-admin is already an (unused)
-- dependency here, but FCM would mean standing up a Firebase project and
-- carrying its SDK on the client for a capability every target browser
-- implements natively. VAPID needs one self-generated keypair and no third
-- party at all.
--
-- DELIVERY IS SWEPT, NOT HOOKED. Notifications are written from a dozen
-- places — settlement, streaks, rewards, the horizon cron, admin alerts, some
-- of them from inside SQL functions that cannot make an HTTP call. Hooking
-- each site would mean missing the next one somebody adds. Instead every
-- notification row carries a `pushed_at`, and one sweeper pushes whatever is
-- unpushed. Anything that writes a notification gets push for free, forever.

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The push service endpoint IS the identity of a subscription. Unique so a
  -- browser re-registering (which happens on its own schedule) updates its row
  -- rather than accumulating duplicates and sending the same person four
  -- copies of everything.
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  -- Set when the push service tells us the subscription is dead (404/410).
  -- Kept rather than deleted so a device that goes quiet is distinguishable
  -- from one that never existed.
  failed_at   timestamptz,
  fail_reason text
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id) WHERE failed_at IS NULL;

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subscriptions_owner ON public.push_subscriptions;
CREATE POLICY push_subscriptions_owner ON public.push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- ── The sweep cursor ───────────────────────────────────────────────────────
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

-- Partial index on exactly the sweeper's query. Without it that scan walks the
-- whole notifications table every minute forever.
CREATE INDEX IF NOT EXISTS notifications_unpushed_idx
  ON public.notifications (created_at)
  WHERE pushed_at IS NULL AND user_id IS NOT NULL;

-- ── What to push next ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pending_push_notifications(p_limit integer DEFAULT 100)
RETURNS TABLE (
  notification_id uuid,
  user_id     uuid,
  type        text,
  message     text,
  action_url  text,
  endpoint    text,
  p256dh      text,
  auth        text,
  subscription_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.id, n.user_id, n.type, n.message, n.action_url,
         s.endpoint, s.p256dh, s.auth, s.id
    FROM public.notifications n
    JOIN public.push_subscriptions s
      ON s.user_id = n.user_id AND s.failed_at IS NULL
   WHERE n.pushed_at IS NULL
     -- Admin alerts have user_id NULL and no device to go to.
     AND n.user_id IS NOT NULL
     -- Anything older than a day is history, not news. Pushing a backlog after
     -- an outage would buzz someone's phone twenty times for things that have
     -- already happened.
     AND n.created_at > now() - interval '24 hours'
   ORDER BY n.created_at ASC
   LIMIT p_limit;
$$;

-- Marked pushed whether or not every device accepted it: a retry loop over a
-- permanently broken device would re-push to that user's healthy devices too.
CREATE OR REPLACE FUNCTION public.mark_notifications_pushed(p_ids uuid[])
RETURNS integer
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE public.notifications SET pushed_at = now()
     WHERE id = ANY(p_ids) AND pushed_at IS NULL
     RETURNING 1
  ) SELECT COUNT(*)::integer FROM upd;
$$;

CREATE OR REPLACE FUNCTION public.mark_push_subscription_failed(
  p_subscription_id uuid, p_reason text
)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.push_subscriptions
     SET failed_at = now(), fail_reason = left(COALESCE(p_reason, ''), 200)
   WHERE id = p_subscription_id;
$$;

REVOKE ALL ON FUNCTION public.pending_push_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pending_push_notifications(integer) TO service_role;
REVOKE ALL ON FUNCTION public.mark_notifications_pushed(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notifications_pushed(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.mark_push_subscription_failed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_push_subscription_failed(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
