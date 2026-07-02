-- Monitor & Mechanic schema for the /ops control panel.
--
-- Adds three new tables — user_complaints, mechanic_log, system_alerts
-- — and extends notifications with severity/category/reference_code so
-- the same table doubles as the user's in-app inbox. Additive only:
-- no existing column changes types, no existing row is touched.
--
-- Design intent:
--   * user_complaints  — every user-submitted "something wrong?" form,
--                        with a short reference code the user quotes
--                        later, AI-triaged category, and a full status
--                        lifecycle (submitted → resolved).
--   * mechanic_log     — one row per scan/fix action Mechanic takes.
--                        Records the reverse operation where one exists,
--                        so Undo becomes a real button for money moves.
--   * system_alerts    — deduplicated (by fingerprint) alerts surfaced
--                        on /ops. Auto-resolve on the next scan when
--                        the underlying issue is gone.
--   * mechanic_state   — singleton row tracking the circuit-breaker
--                        pause flag and last-run stamps. Actions/window
--                        counts derive from mechanic_log on demand.

-- ── user_complaints ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_complaints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Short human-friendly reference code (e.g. 'A47B') the user can
  -- quote in a follow-up. Unique across all complaints, ever.
  reference_code       text UNIQUE NOT NULL,
  -- User-selected category in the modal. AI triage may override this
  -- into ai_triage_category during processing.
  type                 text NOT NULL
    CHECK (type IN ('bet_stuck', 'deposit_missing', 'withdrawal_delayed', 'balance_wrong', 'other')),
  description          text,
  -- What the user was looking at / linked to when they filed.
  related_bet_id       uuid,
  related_slip_id      uuid,
  related_market_id    bigint,
  -- Auto-attached snapshot: balance at submission, last N actions,
  -- browser/user-agent, page they were on. Kept as jsonb so we can
  -- iterate the shape without a migration.
  context              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Lifecycle. Enforced with a check constraint.
  status               text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'mechanic_attempting', 'mechanic_fixed', 'monitor_review', 'admin_working', 'resolved', 'closed')),
  -- Mechanic pass results — the auto-attempt on submission.
  mechanic_attempted   boolean NOT NULL DEFAULT false,
  mechanic_result      jsonb,
  ai_triage_category   text,
  ai_triage_confidence numeric,
  -- Admin correspondence.
  assigned_admin_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  admin_response       text,
  admin_responded_at   timestamptz,
  -- Aggregation: multiple complaints about the same underlying issue
  -- get collapsed into one alert card — this points at the "parent"
  -- complaint the aggregator considers canonical.
  aggregate_parent_id  uuid REFERENCES public.user_complaints(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_user_complaints_status         ON public.user_complaints (status);
CREATE INDEX IF NOT EXISTS idx_user_complaints_user_id_recent ON public.user_complaints (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_complaints_type_status    ON public.user_complaints (type, status);
CREATE INDEX IF NOT EXISTS idx_user_complaints_aggregate      ON public.user_complaints (aggregate_parent_id) WHERE aggregate_parent_id IS NOT NULL;

ALTER TABLE public.user_complaints ENABLE ROW LEVEL SECURITY;

-- Users can read their own complaints — used by the "my history" tab.
DROP POLICY IF EXISTS "Users read own complaints" ON public.user_complaints;
CREATE POLICY "Users read own complaints" ON public.user_complaints
  FOR SELECT USING (auth.uid() = user_id);

-- Users can INSERT their own complaint (the modal submits from a
-- logged-in session). Anon/service_role paths handle everything else.
DROP POLICY IF EXISTS "Users insert own complaints" ON public.user_complaints;
CREATE POLICY "Users insert own complaints" ON public.user_complaints
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ── mechanic_log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mechanic_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Groups actions from the same scan run. A single heartbeat produces
  -- one run_id across many detect/fix rows.
  run_id               uuid NOT NULL,
  scan_category        text NOT NULL,      -- 'settlement' | 'balance' | 'deposit' | 'withdrawal' | 'market' | 'complaint_auto_fix' | 'post_deploy' | 'manual'
  action               text NOT NULL       -- 'detect' | 'fix' | 'alert' | 'skip' | 'error'
    CHECK (action IN ('detect', 'fix', 'alert', 'skip', 'error')),
  operator             text NOT NULL,      -- 'mechanic' | 'admin:<uuid>'  |  'user:<uuid>'
  issue_type           text NOT NULL,      -- 'stuck_slip' | 'orphaned_leg' | 'stuck_resolution' | ...
  -- Identifies the specific offending row so a re-scan can match by
  -- fingerprint rather than free text.
  issue_key            text,
  affected_count       integer NOT NULL DEFAULT 1,
  delta_tngn           numeric,
  affected_user_ids    uuid[],
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The reverse op — enough info to undo this action. Not every fix
  -- has a clean reverse (e.g. settle_multiplier_for_market); those
  -- rows leave this NULL and Undo is grayed out.
  reverse_op           jsonb,
  succeeded            boolean NOT NULL DEFAULT true,
  error                text,
  -- Set when Undo was applied against this row.
  undone_at            timestamptz,
  undone_by            text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mechanic_log_run      ON public.mechanic_log (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mechanic_log_recent   ON public.mechanic_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mechanic_log_category ON public.mechanic_log (scan_category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mechanic_log_action_window ON public.mechanic_log (action, created_at DESC) WHERE action = 'fix';

-- No RLS: service_role only. /ops reads via server routes.
ALTER TABLE public.mechanic_log ENABLE ROW LEVEL SECURITY;

-- ── system_alerts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.system_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity          text NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  category          text NOT NULL,        -- matches mechanic_log.scan_category
  title             text NOT NULL,
  message           text NOT NULL,
  -- Deterministic key so the same underlying issue never inserts twice.
  -- The scanner produces the same fingerprint each run; ON CONFLICT
  -- updates last_seen_at + occurrence_count instead of piling up rows.
  fingerprint       text UNIQUE NOT NULL,
  affected_ids      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'auto_resolved', 'admin_resolved')),
  acknowledged_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  resolved_by       text,               -- 'auto' or 'admin:<uuid>'
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  occurrence_count  integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_system_alerts_open        ON public.system_alerts (status, severity, last_seen_at DESC) WHERE status IN ('open', 'acknowledged');
CREATE INDEX IF NOT EXISTS idx_system_alerts_category    ON public.system_alerts (category, status);

ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;

-- ── mechanic_state (singleton, circuit-breaker + last-run) ──────────

CREATE TABLE IF NOT EXISTS public.mechanic_state (
  id                       int PRIMARY KEY DEFAULT 1,
  paused                   boolean NOT NULL DEFAULT false,
  pause_reason             text,
  paused_at                timestamptz,
  paused_by                text,
  last_scan_at             timestamptz,
  last_scan_status         text,
  last_scan_issues_found   integer,
  last_scan_fixes_applied  integer,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mechanic_state_single_row CHECK (id = 1)
);

INSERT INTO public.mechanic_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.mechanic_state ENABLE ROW LEVEL SECURITY;

-- ── notifications extension ─────────────────────────────────────────
-- Additive: existing rows continue to work with the DEFAULTs. No
-- destructive changes.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS severity        text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  ADD COLUMN IF NOT EXISTS category        text,
  ADD COLUMN IF NOT EXISTS reference_code  text,   -- links user-facing notifications back to a complaint reference
  ADD COLUMN IF NOT EXISTS action_url      text;   -- optional deep-link the bell can render as "View"

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications (user_id, is_read, created_at DESC);

-- ── reference_code generator ────────────────────────────────────────
-- Six characters, alphanumeric, ambiguity-safe (no O/0/I/1/L). Loops
-- until it finds an unused code — the space is 32^6 ~ 1 billion, so
-- collisions are functionally impossible at any realistic scale, but
-- the loop keeps us honest.

CREATE OR REPLACE FUNCTION public.generate_complaint_reference_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text;
  v_i    integer;
  v_len  constant integer := 6;
BEGIN
  LOOP
    v_code := '';
    FOR v_i IN 1..v_len LOOP
      v_code := v_code || substring(v_alphabet, (floor(random() * length(v_alphabet)) + 1)::int, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.user_complaints WHERE reference_code = v_code) THEN
      RETURN v_code;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_complaint_reference_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_complaint_reference_code() TO service_role;

-- ── bump_alert_occurrences ──────────────────────────────────────────
-- Small helper the scan orchestrator calls to increment occurrence_count
-- on the fingerprints it just upserted. supabase-js's upsert can't do
-- an "add-1 on conflict" in one round-trip; a separate call is cleaner
-- than fetching all counts and rewriting them.

CREATE OR REPLACE FUNCTION public.bump_alert_occurrences(p_fingerprints text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.system_alerts
    SET occurrence_count = occurrence_count + 1,
        last_seen_at     = now()
  WHERE fingerprint = ANY(p_fingerprints);
$$;

REVOKE ALL ON FUNCTION public.bump_alert_occurrences(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_alert_occurrences(text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
