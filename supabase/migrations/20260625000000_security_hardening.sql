-- Security hardening pass — addresses everything Supabase's database
-- advisor flagged plus the RLS gaps I found alongside it.
--
--   1. reserve_health view re-declared with security_invoker = on.
--      Postgres views default to SECURITY DEFINER semantics, which
--      bypasses RLS on the underlying table. house_reserve IS RLS-
--      locked (service-role only), but the view was opening a hole the
--      width of the entire reserve to anyone authenticated. Switching
--      to security_invoker makes the view honour the caller's RLS —
--      service_role still sees everything, authenticated/anon see
--      nothing, which is the intended posture.
--
--   2. RLS enabled (no permissive policies) on the tables that were
--      missing it. None of these should be readable by anonymous or
--      authenticated clients; the server-side service-role pathways
--      already in production keep working unchanged. Tables touched:
--      points_log, bet_insurance_events, terms_acceptance_log,
--      jackpot_pool, error_log, api_sports_processed, heartbeat_log.
--      points_log gets an owner-read policy because the leaderboard
--      and forensic drawer already read it through service-role; an
--      owner-read policy is forward-compatible if we ever swap to a
--      client-side read.
--
-- No data migration. All idempotent — re-running is safe.

-- ── 1. reserve_health view ──────────────────────────────────────────
DROP VIEW IF EXISTS public.reserve_health;

CREATE VIEW public.reserve_health
WITH (security_invoker = on) AS
SELECT
  total_tngn,
  floor_tngn,
  GREATEST(0, total_tngn - floor_tngn) AS deployable_tngn,
  CASE WHEN floor_tngn > 0
       THEN GREATEST(0, total_tngn - floor_tngn) / floor_tngn
       ELSE 0
  END AS health_ratio,
  updated_at
FROM public.house_reserve
WHERE id = 1;

COMMENT ON VIEW public.reserve_health IS
  'Read-only view of house_reserve. security_invoker = on so callers see only what their own RLS allows — house_reserve is service-role only, so anon/authenticated get nothing. health_ratio = deployable / floor.';

REVOKE ALL ON public.reserve_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reserve_health TO service_role;

-- ── 2. RLS gaps ─────────────────────────────────────────────────────

-- points_log — leaderboard + dashboard read through service-role today.
-- Owner-read policy is the forward-compatible posture for any future
-- client-side "show my points history" surface; service_role keeps
-- bypassing RLS unchanged.
ALTER TABLE public.points_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS points_log_owner_read ON public.points_log;
CREATE POLICY points_log_owner_read ON public.points_log
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- bet_insurance_events — refund history, user_id-keyed. Owner-read.
ALTER TABLE public.bet_insurance_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bet_insurance_owner_read ON public.bet_insurance_events;
CREATE POLICY bet_insurance_owner_read ON public.bet_insurance_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- terms_acceptance_log — TOS records, includes IP + user agent. No
-- client read surface; service-role only.
ALTER TABLE public.terms_acceptance_log ENABLE ROW LEVEL SECURITY;
-- No SELECT policy → authenticated/anon get nothing. service_role
-- bypasses RLS as usual.

-- jackpot_pool — house balance number. Service-role only; reads happen
-- via the chart endpoint server-side.
ALTER TABLE public.jackpot_pool ENABLE ROW LEVEL SECURITY;

-- error_log — server-internal. Could contain PII in stack traces.
ALTER TABLE public.error_log ENABLE ROW LEVEL SECURITY;

-- api_sports_processed — sports oracle dedupe cache. No client surface.
ALTER TABLE public.api_sports_processed ENABLE ROW LEVEL SECURITY;

-- heartbeat_log — cron health. No client surface.
ALTER TABLE public.heartbeat_log ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
