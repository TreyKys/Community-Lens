-- admin_delete_open_market / admin_reschedule_open_market.
--
-- Two properties matter more than the happy path:
--
--   1. Delete must be REFUSED, not silently blocked, the moment a market has
--      any real trade on it — and the existing FK RESTRICT constraints are
--      what actually enforce that; this function only has to surface a
--      readable message instead of a raw foreign_key_violation, and it must
--      not have accidentally deleted anything before hitting that error.
--   2. Reschedule must re-validate against the market's CURRENT state, not
--      just accept whatever an admin types — the same guards
--      review_open_market applies at approval time.
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
  admin   uuid := '11111111-1111-1111-1111-111111111111';
  other   uuid := '22222222-2222-2222-2222-222222222222';
  punter  uuid := '33333333-3333-3333-3333-333333333333';
  mkt_pending  uuid;  -- never approved — the clean delete case
  mkt_pending2 uuid;  -- never approved — stays alive, for the status guard
  mkt_open     uuid;  -- approved, never traded — reschedule target
  mkt_traded   uuid;  -- approved and traded — delete must refuse this one
  r record;
  logged jsonb;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES
    (admin ,'admin@x.com' ,'admin' , 500000),
    (other ,'other@x.com' ,'other' , 500000),
    (punter,'punt@x.com'  ,'punter', 500000);

  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Will the pending submission ever open?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '30 days', p_submitted_by => admin);
  mkt_pending := r.market_id;

  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Will this second pending submission stay untouched?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '30 days', p_submitted_by => admin);
  mkt_pending2 := r.market_id;

  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Will this market ever get rescheduled?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '30 days', p_submitted_by => admin);
  mkt_open := r.market_id;
  PERFORM public.review_open_market(mkt_open, other, 'approve', 12::smallint, NULL, NULL, 'ok',
                                     'starter', now() + interval '30 days', NULL);

  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL, p_question => 'Will this market get real trades on it?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '30 days', p_submitted_by => admin);
  mkt_traded := r.market_id;
  PERFORM public.review_open_market(mkt_traded, other, 'approve', 12::smallint, NULL, NULL, 'ok',
                                     'starter', now() + interval '30 days', NULL);
  PERFORM public.execute_open_trade(gen_random_uuid(), mkt_traded, punter, 0, 500, 100000);

  ---------------------------------------------------------------- delete guards
  SELECT * INTO r FROM public.admin_delete_open_market(mkt_pending, NULL, 'cleanup');
  PERFORM pg_temp.check('delete refused with no admin id', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_delete_open_market(mkt_pending, admin, 'x');
  PERFORM pg_temp.check('delete refused with too-short a reason', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_delete_open_market(gen_random_uuid(), admin, 'cleaning up a ghost id');
  PERFORM pg_temp.check('delete on a missing market reports not found', NOT r.applied AND r.reason = 'Market not found');

  ------------------------------------------------------- the clean delete case
  SELECT * INTO r FROM public.admin_delete_open_market(mkt_pending, admin, 'never approved, dead submission');
  PERFORM pg_temp.check('a never-traded submission deletes cleanly', r.applied, r.reason);
  PERFORM pg_temp.check('the row is actually gone',
    NOT EXISTS (SELECT 1 FROM public.open_markets WHERE id = mkt_pending));

  SELECT metadata INTO logged FROM public.treasury_log
   WHERE type = 'admin_alert' AND metadata->>'action' = 'open_market_deleted'
     AND metadata->>'market_id' = mkt_pending::text;
  PERFORM pg_temp.check('the deletion left an audit row naming the market and the admin',
    logged IS NOT NULL AND logged->>'admin_id' = admin::text, COALESCE(logged::text, 'none'));

  ------------------------------------------------- the refusal case that matters
  SELECT * INTO r FROM public.admin_delete_open_market(mkt_traded, admin, 'trying to delete a traded market');
  PERFORM pg_temp.check('a market with a real trade refuses to delete',
    NOT r.applied AND r.reason ILIKE '%void%', r.reason);
  PERFORM pg_temp.check('and it is genuinely still there — the refusal did not half-apply',
    EXISTS (SELECT 1 FROM public.open_markets WHERE id = mkt_traded));
  PERFORM pg_temp.check('...and so is the trade that protected it',
    EXISTS (SELECT 1 FROM public.open_trades WHERE market_id = mkt_traded));

  ---------------------------------------------------------------- reschedule
  SELECT * INTO r FROM public.admin_reschedule_open_market(
    mkt_traded, NULL, now() + interval '10 days', NULL);
  PERFORM pg_temp.check('reschedule refused with no admin id', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_reschedule_open_market(
    mkt_open, admin, now() - interval '1 hour', NULL);
  PERFORM pg_temp.check('reschedule refused: closing time already in the past', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_reschedule_open_market(
    mkt_open, admin, now() + interval '5 days', now() + interval '6 days');
  PERFORM pg_temp.check('reschedule refused: review date on/after the close time', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.admin_reschedule_open_market(
    mkt_open, admin, now() + interval '45 days', now() + interval '40 days');
  PERFORM pg_temp.check('a well-formed reschedule on an open market applies', r.applied, r.reason);
  PERFORM pg_temp.check('trading_closes_at actually moved',
    (SELECT trading_closes_at FROM public.open_markets WHERE id = mkt_open) > now() + interval '44 days');
  PERFORM pg_temp.check('horizon_at actually moved too',
    (SELECT horizon_at FROM public.open_markets WHERE id = mkt_open) > now() + interval '39 days');

  SELECT * INTO r FROM public.admin_reschedule_open_market(
    mkt_pending2, admin, now() + interval '10 days', NULL);
  PERFORM pg_temp.check('reschedule refused on a status other than open/horizon_window',
    NOT r.applied AND r.reason ILIKE '%pending_review%', r.reason);
END
$t$;
