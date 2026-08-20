-- event_tag: the hub-routing column.
--
-- Two things under test here, and the second is the one that would actually
-- have taken production down:
--
--   1. The column behaves — normalised, nullable, visible to the review queue.
--   2. submit_open_market has exactly ONE overload. Adding a parameter via
--      CREATE OR REPLACE does not replace a function in Postgres, it creates
--      a second one alongside it, because the parameter list is part of the
--      function's identity. supabase-js .rpc() always calls by NAMED
--      arguments, so every pre-existing call site — all of which omit
--      p_event_tag — would match both overloads and raise "function is not
--      unique". Every Open Markets submission on the site would have started
--      failing. The migration drops the old signature explicitly; this test
--      is what keeps it dropped.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 46), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 46), detail;
  END IF;
END$$;

DO $t$
DECLARE
  creator uuid := '11111111-1111-1111-1111-111111111111';
  admin   uuid := '22222222-2222-2222-2222-222222222222';
  r record; n integer; mkt uuid; v_tag text;
BEGIN
  INSERT INTO public.users(id,email,username) VALUES
    (creator,'c@x.com','creator'), (admin,'a@x.com','admin');

  ------------------------------------------------------------------ overloads
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'submit_open_market';
  PERFORM pg_temp.check('exactly one submit_open_market overload', n = 1,
    n || ' found — more than one makes every named-arg call ambiguous');

  ------------------------------------------------------------------ legacy call
  -- Omits p_event_tag, exactly like every call site written before this
  -- migration. Must still work untouched.
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => creator,
    p_question => 'Will the CBN hold the MPR at its next meeting?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Hold','Raise'], p_resolution_source => 'CBN');
  PERFORM pg_temp.check('call without event_tag still works', r.applied, r.reason);
  PERFORM pg_temp.check('untagged market has NULL event_tag',
    (SELECT event_tag FROM public.open_markets WHERE id = r.market_id) IS NULL);

  ------------------------------------------------------------------ tagged
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => creator,
    p_question => 'Who wins Big Brother Naija this season?',
    p_description => NULL, p_category => 'entertainment',
    p_outcomes => ARRAY['Ada','Bola','Chidi'], p_resolution_source => 'Africa Magic',
    p_event_tag => '  BBN  ');
  PERFORM pg_temp.check('tagged submission accepted', r.applied, r.reason);
  mkt := r.market_id;

  -- Whitespace and case are normalised at write time so the hub page can do a
  -- plain .eq('event_tag','bbn') rather than every reader having to remember
  -- to lower/trim.
  SELECT event_tag INTO v_tag FROM public.open_markets WHERE id = mkt;
  PERFORM pg_temp.check('event_tag trimmed and lowercased', v_tag = 'bbn',
    'got ' || COALESCE(quote_literal(v_tag), 'NULL'));

  -- The reviewer needs to see which hub a submission is headed for before
  -- approving it — that's part of judging whether it belongs there at all.
  PERFORM pg_temp.check('review queue exposes event_tag',
    (SELECT event_tag FROM public.open_markets_review_queue WHERE id = mkt) = 'bbn');

  ------------------------------------------------------------------ hub query
  -- Exactly the filter /bbn runs. A tagged-but-unapproved market must NOT be
  -- discoverable: an unapproved market appearing on a public hub page is the
  -- same leak as it appearing in the browse list.
  SELECT count(*) INTO n FROM public.open_markets
   WHERE event_tag = 'bbn'
     AND status IN ('open','horizon_window','closed','pending_payout','resolved');
  PERFORM pg_temp.check('pending_review market is not on the hub', n = 0,
    n || ' visible while still pending review');

  PERFORM public.review_open_market(mkt, admin, 'approve', 12::smallint, NULL, NULL,
    'ok', 'starter', now() + interval '30 days', NULL);

  SELECT count(*) INTO n FROM public.open_markets
   WHERE event_tag = 'bbn'
     AND status IN ('open','horizon_window','closed','pending_payout','resolved');
  PERFORM pg_temp.check('approved market appears on the hub', n = 1, n || ' visible');

  -- The tag routes a market to a hub; it must not quietly change what the
  -- market IS. Category, and therefore every rule keyed off it, is untouched.
  PERFORM pg_temp.check('event_tag does not alter category',
    (SELECT category FROM public.open_markets WHERE id = mkt) = 'entertainment');
END
$t$;
