-- Fix the Welcome Match cutoff.
--
-- The previous extension migration (20260614000000_extend_welcome_match)
-- attempted to set the cutoff to '2026-06-31 23:59:59+01'. That's not a
-- valid timestamp — June has 30 days — and PostgreSQL is strict, so it
-- errors with "date/time field value out of range" rather than rolling
-- to July 1. The UPDATE in that migration therefore aborted, and the
-- cutoff has been sitting at the original 2026-06-20 since then.
--
-- Today is past that cutoff, so claim_welcome_match() returns 0 on
-- every call (the `IF now() > v_cutoff THEN RETURN 0` branch), and
-- no welcome_match row ever lands in treasury_log. Symptom from the
-- user side: signup → first deposit → no bonus credit.
--
-- Fix: bump the cutoff to a clearly valid date that comfortably
-- outlasts the current acquisition push, and re-assert active = true
-- in case anyone toggled it during debugging.

UPDATE public.launch_promo
   SET cutoff = '2026-12-31 23:59:59+01',
       active = true
 WHERE id = 1;
