-- admin_topup_house_reserve.
--
-- Written directly against the scenario that happened for real on
-- 2026-09-08: total_tngn had drifted below floor_tngn (nothing had settled
-- in 51 days), deployable_tngn was pinned at 0 by GREATEST(0, ...), and
-- there was no lever except a hand-typed UPDATE to fix it. The one property
-- that matters most here: a top-up must land on total_tngn exactly, and
-- deployable must come back correctly even when starting BELOW the floor,
-- not just from a healthy baseline.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 58), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 58), detail;
  END IF;
END$$;

DO $t$
DECLARE
  r record;
  before_total numeric;
  before_count integer;
BEGIN
  -- Mirror the real incident: reserve below its own floor.
  UPDATE public.house_reserve SET total_tngn = 15857.46, floor_tngn = 30000 WHERE id = 1;

  ---------------------------------------------------------------- guards
  SELECT * INTO r FROM public.admin_topup_house_reserve(0, 'zero amount');
  PERFORM pg_temp.check('refused: amount must be positive (zero)', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_topup_house_reserve(-500, 'negative amount');
  PERFORM pg_temp.check('refused: amount must be positive (negative)', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_topup_house_reserve(15_000_000, 'too large a single top-up');
  PERFORM pg_temp.check('refused: over the ₦10,000,000 single-call cap', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_topup_house_reserve(500000, 'x');
  PERFORM pg_temp.check('refused: reason too short', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_topup_house_reserve(500000, NULL);
  PERFORM pg_temp.check('refused: reason missing entirely', NOT r.applied, r.reason);

  -- None of the refusals above should have touched the reserve.
  PERFORM pg_temp.check('reserve untouched by every refused attempt',
    (SELECT total_tngn FROM public.house_reserve WHERE id = 1) = 15857.46);

  ------------------------------------------------------- the real scenario
  before_total := (SELECT total_tngn FROM public.house_reserve WHERE id = 1);
  before_count := (SELECT count(*) FROM public.treasury_log WHERE type = 'reserve_topup');

  SELECT * INTO r FROM public.admin_topup_house_reserve(500000, 'manual capital injection — reserve had drifted below floor');
  PERFORM pg_temp.check('a well-formed top-up applies', r.applied, r.reason);
  PERFORM pg_temp.check('new_total_tngn is exactly before + amount',
    r.new_total_tngn = before_total + 500000, r.new_total_tngn::text);
  PERFORM pg_temp.check('new_deployable_tngn is correct even starting BELOW floor',
    r.new_deployable_tngn = (before_total + 500000) - 30000, r.new_deployable_tngn::text);

  PERFORM pg_temp.check('house_reserve.total_tngn actually moved',
    (SELECT total_tngn FROM public.house_reserve WHERE id = 1) = before_total + 500000);
  PERFORM pg_temp.check('house_reserve.floor_tngn is untouched by a top-up',
    (SELECT floor_tngn FROM public.house_reserve WHERE id = 1) = 30000);
  PERFORM pg_temp.check('reserve_health view agrees',
    (SELECT deployable_tngn FROM public.reserve_health) = r.new_deployable_tngn);

  ------------------------------------------------------------------ audit
  PERFORM pg_temp.check('exactly one new audit row landed in treasury_log',
    (SELECT count(*) FROM public.treasury_log WHERE type = 'reserve_topup') = before_count + 1);
  PERFORM pg_temp.check('the audit row carries the exact amount',
    (SELECT amount_tngn FROM public.treasury_log WHERE type = 'reserve_topup' ORDER BY created_at DESC LIMIT 1) = 500000);
  PERFORM pg_temp.check('the audit row carries the reason in metadata',
    (SELECT metadata->>'reason' FROM public.treasury_log WHERE type = 'reserve_topup' ORDER BY created_at DESC LIMIT 1)
      = 'manual capital injection — reserve had drifted below floor');
  PERFORM pg_temp.check('the audit row is not attributed to any user wallet',
    (SELECT user_id FROM public.treasury_log WHERE type = 'reserve_topup' ORDER BY created_at DESC LIMIT 1) IS NULL);

  ------------------------------------------------------- a second, healthy top-up
  -- Confirms this also works correctly from an already-healthy baseline,
  -- not just the below-floor recovery case above.
  SELECT * INTO r FROM public.admin_topup_house_reserve(1000000, 'routine capital top-up');
  PERFORM pg_temp.check('a top-up from an already-healthy reserve still applies cleanly',
    r.applied AND r.new_deployable_tngn = r.new_total_tngn - 30000, r.reason);
END
$t$;
