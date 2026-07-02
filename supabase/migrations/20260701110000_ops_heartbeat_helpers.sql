-- Advisory lock helpers for the Mechanic heartbeat.
--
-- Netlify Scheduled Functions occasionally fire the same cron twice
-- back-to-back; we don't want two heartbeats running in parallel and
-- both applying the same safe_auto fixes. pg_try_advisory_lock gives
-- us a session-scoped lock that's released automatically when the
-- connection closes, so there's no janitor to worry about.

CREATE OR REPLACE FUNCTION public.mechanic_heartbeat_try_lock()
RETURNS TABLE (locked boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY SELECT pg_try_advisory_lock(4242424242);
END;
$$;

CREATE OR REPLACE FUNCTION public.mechanic_heartbeat_unlock()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_unlock(4242424242);
END;
$$;

REVOKE ALL ON FUNCTION public.mechanic_heartbeat_try_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mechanic_heartbeat_unlock()   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mechanic_heartbeat_try_lock() TO service_role;
GRANT EXECUTE ON FUNCTION public.mechanic_heartbeat_unlock()   TO service_role;

NOTIFY pgrst, 'reload schema';
