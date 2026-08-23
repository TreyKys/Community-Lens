-- Web push plumbing.
--
-- The failure modes worth testing here are all about SENDING TWICE or SENDING
-- WRONG, because both are visible on a stranger's phone and neither shows up
-- in a typecheck:
--
--   * the same notification pushed on every sweep (sweeper never marks)
--   * a whole day's backlog fired at once after an outage
--   * pushes aimed at a device that stopped existing weeks ago
--   * admin alerts (user_id NULL) trying to find a device
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 52), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 52), detail;
  END IF;
END$$;

DO $t$
DECLARE
  u uuid := '11111111-1111-1111-1111-111111111111';
  v uuid := '22222222-2222-2222-2222-222222222222';
  s1 uuid; s2 uuid;
  n1 uuid; n2 uuid; n_old uuid; n_admin uuid;
  cnt integer;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES (u,'a@x.com','alpha',0,0), (v,'b@x.com','beta',0,0);

  INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES (u,'https://push.example/aaa','k1','a1') RETURNING id INTO s1;
  INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES (v,'https://push.example/bbb','k2','a2') RETURNING id INTO s2;

  ---------------------------------------------------------------- identity
  -- A browser re-subscribes on its own schedule and hands back the same
  -- endpoint. Without the unique constraint that is a second row, and the
  -- person gets two of every notification from then on.
  BEGIN
    INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
    VALUES (u,'https://push.example/aaa','k1b','a1b');
    PERFORM pg_temp.check('a repeated endpoint is refused', false, 'duplicate accepted');
  EXCEPTION WHEN unique_violation THEN
    PERFORM pg_temp.check('a repeated endpoint is refused', true);
  END;

  -- The route upserts on that constraint, so the keys must actually rotate.
  INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES (u,'https://push.example/aaa','k1-new','a1-new')
  ON CONFLICT (endpoint) DO UPDATE
    SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failed_at = NULL;
  PERFORM pg_temp.check('re-subscribing rotates keys in place',
    (SELECT count(*) FROM public.push_subscriptions WHERE user_id=u) = 1
    AND (SELECT p256dh FROM public.push_subscriptions WHERE user_id=u) = 'k1-new');

  ---------------------------------------------------------------- the queue
  INSERT INTO public.notifications(user_id,type,message,action_url)
  VALUES (u,'bet_won','You won ₦4,200','/bets') RETURNING id INTO n1;
  INSERT INTO public.notifications(user_id,type,message)
  VALUES (v,'streak_reward','7 days running — ₦200 added') RETURNING id INTO n2;

  PERFORM pg_temp.check('both users are queued',
    (SELECT count(*) FROM public.pending_push_notifications(100)) = 2);
  PERFORM pg_temp.check('the payload carries what the phone shows',
    (SELECT message FROM public.pending_push_notifications(100)
      WHERE notification_id = n1) = 'You won ₦4,200'
    AND (SELECT action_url FROM public.pending_push_notifications(100)
          WHERE notification_id = n1) = '/bets');
  PERFORM pg_temp.check('and the keys needed to encrypt it',
    (SELECT p256dh FROM public.pending_push_notifications(100)
      WHERE notification_id = n1) = 'k1-new');

  ---------------------------------------------------------------- no device
  -- Someone who never allowed notifications must not hold a row in the queue
  -- forever. The JOIN drops them; this asserts it, because an OUTER join here
  -- would leave the sweeper looping over unsendable rows every minute.
  DELETE FROM public.push_subscriptions WHERE id = s2;
  PERFORM pg_temp.check('a user with no device is not queued',
    (SELECT count(*) FROM public.pending_push_notifications(100)) = 1);
  INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES (v,'https://push.example/bbb','k2','a2') RETURNING id INTO s2;

  ---------------------------------------------------------------- admin rows
  n_admin := gen_random_uuid();
  INSERT INTO public.notifications(id,user_id,type,message)
  VALUES (n_admin,NULL,'admin_alert','Treasury below floor');
  PERFORM pg_temp.check('admin alerts have no phone to reach',
    NOT EXISTS (SELECT 1 FROM public.pending_push_notifications(100)
                 WHERE notification_id = n_admin));

  ---------------------------------------------------------------- staleness
  -- The one that matters after an outage. Three days of unsent notifications
  -- must not all arrive at once at 6am.
  n_old := gen_random_uuid();
  INSERT INTO public.notifications(id,user_id,type,message,created_at)
  VALUES (n_old,u,'bet_won','Old news', now() - interval '3 days');
  PERFORM pg_temp.check('yesterday''s backlog is not fired today',
    NOT EXISTS (SELECT 1 FROM public.pending_push_notifications(100)
                 WHERE notification_id = n_old));
  PERFORM pg_temp.check('but it is still readable in the app',
    (SELECT pushed_at IS NULL FROM public.notifications WHERE id = n_old));

  ---------------------------------------------------------------- marking
  SELECT public.mark_notifications_pushed(ARRAY[n1, n2]) INTO cnt;
  PERFORM pg_temp.check('marking reports what it changed', cnt = 2, cnt::text);
  PERFORM pg_temp.check('a pushed notification leaves the queue',
    (SELECT count(*) FROM public.pending_push_notifications(100)) = 0);

  -- Idempotent: a sweeper that crashes after pushing but before marking will
  -- re-run, and a second mark must be a no-op rather than an error.
  SELECT public.mark_notifications_pushed(ARRAY[n1, n2]) INTO cnt;
  PERFORM pg_temp.check('re-marking changes nothing', cnt = 0, cnt::text);

  ---------------------------------------------------------------- dead device
  PERFORM public.mark_push_subscription_failed(s1, '410 Gone');
  PERFORM pg_temp.check('a dead subscription is recorded, not deleted',
    (SELECT failed_at IS NOT NULL FROM public.push_subscriptions WHERE id = s1));
  PERFORM pg_temp.check('with the reason kept for diagnosis',
    (SELECT fail_reason FROM public.push_subscriptions WHERE id = s1) = '410 Gone');

  INSERT INTO public.notifications(user_id,type,message)
  VALUES (u,'bet_lost','Better luck next time');
  PERFORM pg_temp.check('nothing is sent to a dead device',
    (SELECT count(*) FROM public.pending_push_notifications(100)) = 0);

  -- Coming back from the dead: allowing notifications again on the same
  -- browser must revive the row, or that person is silenced permanently.
  INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES (u,'https://push.example/aaa','k1-rev','a1-rev')
  ON CONFLICT (endpoint) DO UPDATE
    SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        failed_at = NULL, fail_reason = NULL;
  PERFORM pg_temp.check('re-allowing revives the subscription',
    (SELECT count(*) FROM public.pending_push_notifications(100)) = 1);

  ---------------------------------------------------------------- fan-out
  -- Phone and laptop: one notification, two devices, both must be sent to.
  INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES (u,'https://push.example/ccc','k3','a3');
  PERFORM pg_temp.check('one notification fans out to every device',
    (SELECT count(*) FROM public.pending_push_notifications(100)) = 2);
  PERFORM pg_temp.check('but it is a single notification row',
    (SELECT count(DISTINCT notification_id) FROM public.pending_push_notifications(100)) = 1);

  ---------------------------------------------------------------- cascade
  DELETE FROM public.users WHERE id = v;
  PERFORM pg_temp.check('deleting a user takes their devices with them',
    NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = v));

  ---------------------------------------------------------------- limit
  FOR cnt IN 1..5 LOOP
    INSERT INTO public.notifications(user_id,type,message)
    VALUES (u,'bet_won','win ' || cnt);
  END LOOP;
  PERFORM pg_temp.check('the batch limit is honoured',
    (SELECT count(*) FROM public.pending_push_notifications(3)) = 3);
  PERFORM pg_temp.check('oldest first, so nothing starves',
    (SELECT message FROM public.pending_push_notifications(1)) = 'Better luck next time');
END$t$;
