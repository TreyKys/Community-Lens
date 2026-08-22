-- Streaks.
--
-- These pay real bonus credit, so the tests are written around the ways a
-- payout goes wrong: claiming twice, claiming early, and a streak that should
-- have broken still reading as unbroken.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 48), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 48), detail;
  END IF;
END$$;

DO $t$
DECLARE
  u    uuid := '11111111-1111-1111-1111-111111111111';
  v    uuid := '22222222-2222-2222-2222-222222222222';
  today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  r record; s record; bal numeric; n integer;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES (u,'a@x.com','streaker',0,0), (v,'b@x.com','other',0,0);

  ------------------------------------------------------------------ recording
  PERFORM public.record_streak_activity(u, true, 0, false, NULL);
  PERFORM pg_temp.check('a visit is recorded',
    (SELECT opened FROM public.user_activity_days WHERE user_id=u AND day=today));

  -- opened must be STICKY: a later stake call passing false must not erase
  -- the visit that already happened today.
  PERFORM public.record_streak_activity(u, false, 800, false, 'sport');
  SELECT * INTO r FROM public.user_activity_days WHERE user_id=u AND day=today;
  PERFORM pg_temp.check('opened stays true after a false call', r.opened);
  PERFORM pg_temp.check('stake accumulates', r.staked_tngn = 800, r.staked_tngn::text);

  -- Same day, more money and a second category: both accumulate, categories
  -- stay distinct.
  PERFORM public.record_streak_activity(u, false, 200, false, 'sport');
  PERFORM public.record_streak_activity(u, false, 500, false, 'politics');
  SELECT * INTO r FROM public.user_activity_days WHERE user_id=u AND day=today;
  PERFORM pg_temp.check('stakes sum across calls', r.staked_tngn = 1500, r.staked_tngn::text);
  PERFORM pg_temp.check('categories deduplicate',
    array_length(r.categories,1) = 2, array_to_string(r.categories,','));

  ------------------------------------------------------------------ progress
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='login_7';
  PERFORM pg_temp.check('login streak shows partial progress',
    s.progress = 1 AND s.target = 7 AND NOT s.claimable, s.progress || '/' || s.target);

  -- Claiming before finishing must be refused, and must say how far off.
  SELECT * INTO r FROM public.claim_streak_reward(u, 'login_7');
  PERFORM pg_temp.check('cannot claim an unfinished streak', NOT r.applied, r.reason);

  ------------------------------------------------------------------ 7 days
  -- Backfill six earlier days so today completes a run of seven.
  FOR n IN 1..6 LOOP
    INSERT INTO public.user_activity_days(user_id, day, opened, staked_tngn)
    VALUES (u, today - n, true, 800);
  END LOOP;

  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='login_7';
  PERFORM pg_temp.check('7 consecutive days completes it',
    s.progress = 7 AND s.claimable, s.progress || '/' || s.target);

  SELECT bonus_balance INTO bal FROM public.users WHERE id=u;
  SELECT * INTO r FROM public.claim_streak_reward(u, 'login_7');
  PERFORM pg_temp.check('claim pays', r.applied AND r.reward_tngn = 200, r.reason);
  PERFORM pg_temp.check('paid into BONUS, not cash',
    (SELECT bonus_balance FROM public.users WHERE id=u) = bal + 200
    AND (SELECT tngn_balance FROM public.users WHERE id=u) = 0);

  -- The one that actually matters.
  SELECT * INTO r FROM public.claim_streak_reward(u, 'login_7');
  PERFORM pg_temp.check('cannot claim the same streak twice', NOT r.applied, r.reason);
  PERFORM pg_temp.check('only one claim row exists',
    (SELECT count(*) FROM public.streak_claims WHERE user_id=u AND streak_id='login_7') = 1);

  ------------------------------------------------------------------ stake floor
  -- The ₦500/day floor is what stops seven ₦100 stakes earning ₦500. Rewrite
  -- the week below the floor and the staking streak must not complete.
  UPDATE public.user_activity_days SET staked_tngn = 100 WHERE user_id = u;
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='stake_7';
  PERFORM pg_temp.check('sub-floor stakes do not count',
    s.progress = 0 AND NOT s.claimable, s.progress || '/' || s.target);

  UPDATE public.user_activity_days SET staked_tngn = 500 WHERE user_id = u;
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='stake_7';
  PERFORM pg_temp.check('exactly at the floor does count',
    s.progress = 7 AND s.claimable, s.progress || '/' || s.target);

  ------------------------------------------------------------------ breaking
  -- Remove a middle day. The run must break there, not silently bridge it —
  -- a streak that survives a gap is not a streak.
  --
  -- Deleting today-3 leaves today, -1 and -2 intact, so the walk back stops at
  -- the gap having counted THREE days. (Written as 4 first time round, which
  -- the test caught: it is the days before the gap, not up to and including
  -- it.)
  DELETE FROM public.user_activity_days WHERE user_id = u AND day = today - 3;
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='login_7';
  PERFORM pg_temp.check('a missed day breaks the run',
    s.progress = 3, s.progress || '/' || s.target);

  ------------------------------------------------------------------ weekly
  PERFORM public.record_streak_activity(v, true, 600, false, 'sport');
  PERFORM public.record_streak_activity(v, false, 600, false, 'politics');
  SELECT * INTO s FROM public.get_streak_state(v) WHERE streak_id='explorer';
  PERFORM pg_temp.check('explorer counts distinct categories',
    s.progress = 2 AND NOT s.claimable, s.progress || '/' || s.target);

  PERFORM public.record_streak_activity(v, false, 600, false, 'economy');
  SELECT * INTO s FROM public.get_streak_state(v) WHERE streak_id='explorer';
  PERFORM pg_temp.check('third category completes explorer',
    s.progress = 3 AND s.claimable, s.progress || '/' || s.target);

  SELECT * INTO r FROM public.claim_streak_reward(v, 'explorer');
  PERFORM pg_temp.check('explorer pays 300', r.applied AND r.reward_tngn = 300, r.reason);

  ------------------------------------------------------------------ trades
  FOR n IN 1..5 LOOP
    PERFORM public.record_streak_activity(v, false, 0, true, NULL);
  END LOOP;
  SELECT * INTO s FROM public.get_streak_state(v) WHERE streak_id='trader_5';
  PERFORM pg_temp.check('5 trades completes the trader streak',
    s.progress = 5 AND s.claimable, s.progress || '/' || s.target);
  SELECT * INTO r FROM public.claim_streak_reward(v, 'trader_5');
  PERFORM pg_temp.check('trader pays 400', r.applied AND r.reward_tngn = 400, r.reason);

  ------------------------------------------------------------------ isolation
  PERFORM pg_temp.check('one user cannot claim another user''s streak',
    NOT (SELECT applied FROM public.claim_streak_reward(u, 'explorer')));

  PERFORM pg_temp.check('every reward is within the 500 cap',
    NOT EXISTS (SELECT 1 FROM public.get_streak_state(u) WHERE reward_tngn > 500));
  PERFORM pg_temp.check('no negative balances',
    NOT EXISTS (SELECT 1 FROM public.users WHERE tngn_balance < 0 OR bonus_balance < 0));
END
$t$;
