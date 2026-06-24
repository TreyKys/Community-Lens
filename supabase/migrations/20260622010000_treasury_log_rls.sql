-- Lock down treasury_log with RLS.
--
-- treasury_log has been world-readable since the original Phase-3
-- schema (20240503000000) — RLS was never enabled. Any authenticated
-- user could SELECT * from it through the anon-key client and read
-- every other user's rake, payout, manual credit, deposit, and welcome
-- match history. That's a privacy leak and would let competitors infer
-- platform financials by scraping the table.
--
-- Fix: enable RLS and grant authenticated users SELECT on their own
-- rows only. Service-role queries (every server route, admin panel
-- analytics, settlement RPCs) bypass RLS as usual and continue to
-- work without changes. The one client-side direct query — the
-- admin Credits panel's "recent manual_credit history" pull — has
-- been moved server-side in the same commit (see
-- packages/app/app/api/admin/credits/route.ts GET handler).
--
-- We deliberately do NOT add INSERT/UPDATE/DELETE policies. All writes
-- to treasury_log happen via SECURITY DEFINER RPCs or service-role
-- server routes; nothing in the app should ever write to this table
-- from an authenticated client session.

ALTER TABLE public.treasury_log ENABLE ROW LEVEL SECURITY;

-- Users can read their own treasury entries (the wallet history surface
-- on /profile relies on this once it's wired to direct queries — for now
-- it goes through a server route, but enabling the read is forward-
-- compatible and avoids a future "why can't I see my own credits"
-- surprise).
DROP POLICY IF EXISTS "treasury_log_owner_read" ON public.treasury_log;
CREATE POLICY "treasury_log_owner_read"
  ON public.treasury_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON POLICY "treasury_log_owner_read" ON public.treasury_log IS
  'Authenticated users can read only treasury_log rows tagged to their own user_id. Admin / analytics queries go through service-role server routes which bypass RLS. Aggregate rows (no user_id) stay hidden from clients.';

NOTIFY pgrst, 'reload schema';
