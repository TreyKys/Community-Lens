-- Enable Postgres replication for the tables the frontend actually
-- subscribes to via supabase-js .channel(...).on('postgres_changes', ...).
--
-- Supabase Realtime only emits postgres_changes events for tables that
-- have been explicitly added to the `supabase_realtime` publication —
-- it starts EMPTY on a new project, and no prior migration ever added
-- anything to it. That means every one of these subscriptions has been
-- silently inert since the day it was written:
--
--   app/(app)/bets/page.tsx        → user_bets, multiplier_slips
--   app/(app)/dashboard/page.tsx   → users
--   components/Navbar.tsx         → users
--   components/NotificationBell.tsx → notifications
--
-- None of them error — postgres_changes just never fires, so the UI
-- only ever reflects the DB state as of the last full fetch (page
-- load, or the 60s poll on the admin drawers). This is why a resolved
-- Multiplier slip's status looked "stuck" client-side even after the
-- database was corrected: nothing was wrong with the query, there was
-- just no live push telling the page to re-fetch.
--
-- multiplier_legs is included even though nothing subscribes to it
-- directly today — every leg settlement also bumps a counter on its
-- parent multiplier_slips row, so the existing subscription already
-- catches it, but adding it directly costs nothing and covers any
-- future UI that wants per-leg live updates without waiting on the
-- parent row to change.
--
-- ADD TABLE has no IF NOT EXISTS form, so guard each one against
-- being re-run (Postgres raises duplicate_object if a table is
-- already a member) — safe to re-apply.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.user_bets;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.multiplier_slips;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.multiplier_legs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- postgres_changes payloads only include OLD row data when the table's
-- REPLICA IDENTITY is FULL (default is just the primary key). None of
-- these subscriptions read the change payload itself (they all just
-- use the event as a trigger to re-fetch), so this isn't required for
-- correctness today — but set it anyway so a future UI that DOES want
-- to diff old vs new values (e.g. "your bet just flipped from active
-- to won") isn't quietly broken by missing OLD data.
ALTER TABLE public.user_bets REPLICA IDENTITY FULL;
ALTER TABLE public.multiplier_slips REPLICA IDENTITY FULL;
ALTER TABLE public.multiplier_legs REPLICA IDENTITY FULL;
