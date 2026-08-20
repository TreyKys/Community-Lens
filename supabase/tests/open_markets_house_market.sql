-- House-market accountability.
--
-- A house market has created_by NULL so that no fee share accrues. Every
-- insider guard in this engine used to key off created_by alone, which meant
-- NULL disabled all of them at once and a single admin could submit a market,
-- approve it, trade it, and pick the winner.
--
-- These tests walk that exact attack and assert it is refused at every step.
-- They are written as the attack rather than as feature checks, because "an
-- admin cannot do X" is only meaningful if the test actually tries X.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 50), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 50), detail;
  END IF;
END$$;

DO $t$
DECLARE
  rogue  uuid := '11111111-1111-1111-1111-111111111111';  -- the admin under test
  other  uuid := '22222222-2222-2222-2222-222222222222';  -- an unrelated admin
  third  uuid := '33333333-3333-3333-3333-333333333333';
  punter uuid := '44444444-4444-4444-4444-444444444444';
  mkt uuid; r record;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES
    (rogue ,'rogue@x.com','rogue' , 500000),
    (other ,'other@x.com','other' , 0),
    (third ,'third@x.com','third' , 0),
    (punter,'punt@x.com' ,'punter', 500000);

  ------------------------------------------------------------------ submit
  -- A HOUSE market: no creator, so no fee share. This is the configuration
  -- that used to disable every guard.
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL,
    p_question => 'Will the CBN hold the MPR at its next meeting?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Hold','Raise'], p_resolution_source => 'CBN',
    p_trading_closes_at => now() + interval '30 days',
    p_submitted_by => rogue);
  PERFORM pg_temp.check('house market submitted', r.applied, r.reason);
  mkt := r.market_id;

  PERFORM pg_temp.check('created_by stays NULL (no fee share)',
    (SELECT created_by FROM public.open_markets WHERE id = mkt) IS NULL);
  PERFORM pg_temp.check('submitted_by records who put it there',
    (SELECT submitted_by FROM public.open_markets WHERE id = mkt) = rogue);

  ------------------------------------------------------------------ attack 1
  -- Approve my own submission, alone.
  SELECT * INTO r FROM public.review_open_market(
    mkt, rogue, 'approve', 12::smallint, NULL, NULL, 'looks great', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('submitter CANNOT approve own house market',
    NOT r.applied, r.reason);

  -- A different admin can, which is the point — this must not simply block
  -- house markets from ever opening.
  SELECT * INTO r FROM public.review_open_market(
    mkt, other, 'approve', 12::smallint, NULL, NULL, 'ok', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('a different admin CAN approve it', r.applied, r.reason);

  ------------------------------------------------------------------ attack 2
  -- Trade the book I put up.
  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, rogue, 0, 1000, 1e9);
    PERFORM pg_temp.check('submitter CANNOT trade own house market', false, 'trade went through!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('submitter CANNOT trade own house market', true, SQLERRM);
  END;

  -- An ordinary user is unaffected.
  PERFORM public.execute_open_trade(gen_random_uuid(), mkt, punter, 0, 1000, 1e9);
  PERFORM pg_temp.check('an ordinary user CAN still trade it',
    (SELECT shares_cash FROM public.open_positions
      WHERE market_id = mkt AND user_id = punter) = 1000);

  ------------------------------------------------------------------ attack 3
  -- Pick the winning outcome on a market I put up.
  UPDATE public.open_markets SET status='closed', trading_closes_at = now() - interval '1 minute'
   WHERE id = mkt;

  SELECT * INTO r FROM public.settle_open_market(mkt, 0, rogue, other, 'http://cbn', true);
  PERFORM pg_temp.check('submitter CANNOT resolve own house market',
    NOT r.applied AND r.reason <> 'dry_run', r.reason);

  -- ...including as the second signature, not just the first.
  SELECT * INTO r FROM public.settle_open_market(mkt, 0, other, rogue, 'http://cbn', true);
  PERFORM pg_temp.check('submitter CANNOT confirm it either',
    NOT r.applied AND r.reason <> 'dry_run', r.reason);

  -- Two uninvolved admins can, so the market is still resolvable.
  SELECT * INTO r FROM public.settle_open_market(mkt, 0, other, third, 'http://cbn', false);
  PERFORM pg_temp.check('two uninvolved admins CAN resolve it', r.applied, r.reason);

  ------------------------------------------------------------------ regression
  -- A normal user submission must behave exactly as before: submitted_by
  -- falls back to created_by, so one person is caught by both checks.
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => punter,
    p_question => 'Will Nigeria qualify for the next AFCON tournament?',
    p_description => NULL, p_category => 'sport',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'CAF',
    p_trading_closes_at => now() + interval '20 days');
  PERFORM pg_temp.check('user submission still works', r.applied, r.reason);
  PERFORM pg_temp.check('submitted_by defaults to the creator',
    (SELECT submitted_by FROM public.open_markets WHERE id = r.market_id) = punter);

  SELECT * INTO r FROM public.review_open_market(
    r.market_id, punter, 'approve', 12::smallint, NULL, NULL, 'mine', 'starter',
    now() + interval '20 days', NULL);
  PERFORM pg_temp.check('user still cannot approve their own', NOT r.applied, r.reason);
END
$t$;
