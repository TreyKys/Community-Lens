-- Cron tick simulation.
--
-- /api/cron/open-markets is the only thing that drives horizons, releases and
-- fee sweeps. Its selection queries decide which markets get touched, and a
-- selector that matches nothing fails completely silently: no error, no log,
-- just money that never moves. So the selectors are tested directly here,
-- against the same predicates the route uses.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 46), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 46), detail;
  END IF;
END$$;

DO $cron$
DECLARE
  creator uuid := '11111111-1111-1111-1111-111111111111';
  admin   uuid := '22222222-2222-2222-2222-222222222222';
  admin2  uuid := '55555555-5555-5555-5555-555555555555';
  alice   uuid := '33333333-3333-3333-3333-333333333333';
  mkt uuid; r record; n integer;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES
    (creator,'c2@x.com','creator2',0), (admin,'a3@x.com','admin3',0),
    (admin2,'a4@x.com','admin4',0), (alice,'al2@x.com','alice2',200000)
  ON CONFLICT (id) DO NOTHING;

  SELECT market_id INTO mkt FROM public.submit_open_market(
    creator, 'Will inflation print below 20% at the next release?', NULL, 'economy',
    ARRAY['Yes','No'], 'NBS', NULL, now() + interval '2 days', now() + interval '20 days');
  PERFORM public.review_open_market(mkt, admin, 'approve', 12::smallint, NULL, NULL,
    'ok', 'starter', now() + interval '20 days', now() + interval '2 days');
  PERFORM public.execute_open_trade(gen_random_uuid(), mkt, alice, 0, 1500, 1e9);

  ------------------------------------------------------------------ step 1
  -- Selector: status='open' AND horizon_at IS NOT NULL AND horizon_at <= now()
  UPDATE public.open_markets SET horizon_at = now() - interval '1 minute' WHERE id = mkt;
  SELECT count(*) INTO n FROM public.open_markets
   WHERE status='open' AND horizon_at IS NOT NULL AND horizon_at <= now();
  PERFORM pg_temp.check('cron finds a due horizon', n = 1, n || ' found');

  SELECT * INTO r FROM public.open_horizon_window(
    mkt, (SELECT horizon_count FROM public.open_markets WHERE id=mkt), 72);
  PERFORM pg_temp.check('cron opens the window', r.applied, r.reason);

  -- Optimistic concurrency: a second overlapping tick reads the OLD count and
  -- must be refused, or two windows open on one market.
  SELECT * INTO r FROM public.open_horizon_window(mkt, 0::smallint, 72);
  PERFORM pg_temp.check('overlapping tick cannot double-open', NOT r.applied, r.reason);

  -- Once opened it must leave the "due" selector, or every tick reopens it.
  SELECT count(*) INTO n FROM public.open_markets
   WHERE status='open' AND horizon_at IS NOT NULL AND horizon_at <= now();
  PERFORM pg_temp.check('opened market leaves the due selector', n = 0, n || ' still due');

  ------------------------------------------------------------------ step 2
  -- Selector: status='horizon_window' AND horizon_window_closes_at <= now()
  SELECT count(*) INTO n FROM public.open_markets
   WHERE status='horizon_window' AND horizon_window_closes_at IS NOT NULL
     AND horizon_window_closes_at <= now();
  PERFORM pg_temp.check('window is not closed early', n = 0, n || ' prematurely due');

  UPDATE public.open_markets SET horizon_window_closes_at = now() - interval '1 minute'
   WHERE id = mkt;
  SELECT count(*) INTO n FROM public.open_markets
   WHERE status='horizon_window' AND horizon_window_closes_at IS NOT NULL
     AND horizon_window_closes_at <= now();
  PERFORM pg_temp.check('cron finds an expired window', n = 1, n || ' found');

  SELECT * INTO r FROM public.close_horizon_window(mkt, now() + interval '30 days', false);
  PERFORM pg_temp.check('cron closes the window', r.applied, r.reason);
  PERFORM pg_temp.check('nobody elected, so nobody was moved',
    (SELECT status FROM public.open_positions
      WHERE market_id=mkt AND user_id=alice) = 'open',
    'doing nothing must mean staying in');

  ------------------------------------------------------------------ step 3
  UPDATE public.open_markets SET status='closed' WHERE id = mkt;
  PERFORM public.settle_open_market(mkt, 0, admin, admin2, 'http://nbs', false);

  -- Selector: status='pending_payout'
  SELECT count(*) INTO n FROM public.open_markets WHERE status='pending_payout';
  PERFORM pg_temp.check('cron finds a market awaiting payout', n = 1, n || ' found');

  -- Inside the dispute window the RPC RAISES. The route must treat that as
  -- skip-and-continue, or one held market stops payouts for every other.
  BEGIN
    PERFORM public.release_open_settlements(mkt, 250, false);
    PERFORM pg_temp.check('release refuses inside the window', false, 'released!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('release refuses inside the window', true, SQLERRM);
  END;

  UPDATE public.open_markets SET settlement_locked_until = now() - interval '1 minute'
   WHERE id = mkt;
  SELECT * INTO r FROM public.release_open_settlements(mkt, 250, false);
  PERFORM pg_temp.check('cron releases once unlocked', r.released > 0 AND r.finished,
    r.released || ' released');

  SELECT count(*) INTO n FROM public.open_markets WHERE status='pending_payout';
  PERFORM pg_temp.check('paid market leaves the payout selector', n = 0, n || ' still pending');

  ------------------------------------------------------------------ step 4
  SELECT count(*) INTO n FROM public.open_markets WHERE fees_collected > fees_swept;
  PERFORM pg_temp.check('cron sees unswept fees', n >= 1, n || ' market(s)');
  SELECT * INTO r FROM public.sweep_open_market_fees();
  PERFORM pg_temp.check('cron sweeps them', r.tngn_swept > 0, round(r.tngn_swept,2) || ' swept');
  SELECT count(*) INTO n FROM public.open_markets WHERE fees_collected > fees_swept;
  PERFORM pg_temp.check('nothing left to sweep', n = 0, n || ' remaining');

  ------------------------------------------------------------------ step 5
  SELECT count(*) INTO n FROM public.scan_open_markets_health() WHERE severity='critical';
  PERFORM pg_temp.check('health scan is clean after a normal life', n = 0,
    (SELECT COALESCE(string_agg(check_name, ', '), 'none')
       FROM public.scan_open_markets_health() WHERE severity='critical'));
END
$cron$;
