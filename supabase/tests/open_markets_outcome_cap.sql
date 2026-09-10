-- submit_open_market's outcome ceiling: raised from 8 to 30
-- (20260910000000_open_markets_raise_outcome_cap.sql).
--
-- The one thing worth being precise about here: the cap is exactly 30, not
-- "around 30" — 30 must succeed, 31 must refuse, and the boundary message
-- has to actually say 30, not the old number left behind in a copy-paste.
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
  admin uuid := '11111111-1111-1111-1111-111111111111';
  r record;
  outcomes_30 text[];
  outcomes_31 text[];
  i integer;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES (admin,'admin@x.com','admin',0);

  outcomes_30 := ARRAY[]::text[];
  FOR i IN 1..30 LOOP outcomes_30 := outcomes_30 || ('Housemate ' || i); END LOOP;
  -- Explicit ::text cast: unadorned, `outcomes_30 || 'Housemate 31'` is
  -- ambiguous between array||element and array||array, and Postgres resolves
  -- it by trying to parse the string AS an array literal first — "malformed
  -- array literal" on a plain string, not the append this actually wants.
  outcomes_31 := outcomes_30 || 'Housemate 31'::text;

  ------------------------------------------------------------------ old cap is gone
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Which housemate leaves the house this week in the eviction?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => outcomes_30, p_resolution_source => 'Live eviction show',
    p_trading_closes_at => now() + interval '3 days', p_submitted_by => admin);
  PERFORM pg_temp.check('exactly 30 outcomes is accepted (the old cap was 8)', r.applied, r.reason);

  PERFORM pg_temp.check('the stored market actually has all 30 outcomes',
    (SELECT array_length(outcomes, 1) FROM public.open_markets WHERE id = r.market_id) = 30);
  PERFORM pg_temp.check('q and q_initial were sized to match — not left at some smaller default',
    (SELECT array_length(q, 1) FROM public.open_markets WHERE id = r.market_id) = 30
    AND (SELECT array_length(q_initial, 1) FROM public.open_markets WHERE id = r.market_id) = 30);

  ------------------------------------------------------------------ the new ceiling
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Which of these 31 things happens first, hypothetically speaking?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => outcomes_31, p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '3 days', p_submitted_by => admin);
  PERFORM pg_temp.check('31 outcomes is refused', NOT r.applied, r.reason);
  PERFORM pg_temp.check('the refusal message actually says 30, not the old 8',
    r.reason = 'A market needs between 2 and 30 outcomes', r.reason);

  ------------------------------------------------------------------ the floor is untouched
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Solo-outcome nonsense question that should never pass',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Only one'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '3 days', p_submitted_by => admin);
  PERFORM pg_temp.check('a single outcome is still refused (the floor of 2 did not move)', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Ordinary binary market — still works exactly as before?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '3 days', p_submitted_by => admin);
  PERFORM pg_temp.check('an ordinary 2-outcome market still works', r.applied, r.reason);
END
$t$;
