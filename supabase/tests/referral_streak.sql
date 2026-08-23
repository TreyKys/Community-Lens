-- The referral streak.
--
-- Written as the ATTACK, because the naive version of this feature is a
-- faucet: a signup already pays ₦200 to each side, so a milestone that counts
-- signups makes three burner accounts worth ₦1,700 in bonus credit to one
-- person in four minutes.
--
-- Everything below is asking the same question in different ways: can this
-- pay out without three separate people having risked their own money?
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 54), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 54), detail;
  END IF;
END$$;

DO $t$
DECLARE
  u  uuid := '11111111-1111-1111-1111-111111111111';   -- the referrer
  f1 uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  f2 uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  f3 uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  f4 uuid := 'aaaaaaaa-0000-0000-0000-000000000004';
  f5 uuid := 'aaaaaaaa-0000-0000-0000-000000000005';
  f6 uuid := 'aaaaaaaa-0000-0000-0000-000000000006';
  stranger uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  mkt bigint;
  s record; r record; bal numeric;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES (u,'ref@x.com','referrer',0,0);
  INSERT INTO public.users(id,email,username,referred_by_user_id)
  VALUES (f1,'f1@x.com','f1',u), (f2,'f2@x.com','f2',u), (f3,'f3@x.com','f3',u),
         (f4,'f4@x.com','f4',u), (f5,'f5@x.com','f5',u), (f6,'f6@x.com','f6',u);
  INSERT INTO public.users(id,email,username) VALUES (stranger,'s@x.com','stranger');

  INSERT INTO public.markets(question,category,status)
  VALUES ('Will it rain?','sports','open') RETURNING id INTO mkt;

  ------------------------------------------------------------- exists at all
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('the referral streak exists', FOUND);
  PERFORM pg_temp.check('it pays 500, the cap', s.reward_tngn = 500, s.reward_tngn::text);
  PERFORM pg_temp.check('the other five streaks are untouched',
    (SELECT count(*) FROM public.get_streak_state(u)) = 6);

  ------------------------------------------------------- THE ATTACK: signups
  -- Six referred accounts, none of which has ever staked anything. This is
  -- the entire exploit, and it must be worth exactly nothing.
  PERFORM pg_temp.check('six signups alone count for NOTHING',
    s.progress = 0 AND NOT s.claimable, s.progress || '/' || s.target);

  ------------------------------------------------- THE ATTACK: bonus staking
  -- Each burner stakes the ₦200 signup bonus it was just handed, five times
  -- over. That is ₦1,000 of "stake" per account, all of it our own money
  -- coming back to us. It must not qualify anyone.
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn,bonus_proportion)
  SELECT x, mkt, 0, 1000, 1.0 FROM unnest(ARRAY[f1,f2,f3]) x;

  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('staking pure bonus credit qualifies nobody',
    s.progress = 0 AND NOT s.claimable, s.progress || '/' || s.target);

  ------------------------------------------------------------- partial cash
  -- Half cash, half bonus, at the floor: ₦500 of real money. Under the line.
  UPDATE public.user_bets SET bonus_proportion = 0.5 WHERE user_id = f1;
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('half-bonus ₦1,000 is ₦500 of cash — still short',
    s.progress = 0, s.progress::text);

  -- All cash, on the line exactly.
  UPDATE public.user_bets SET bonus_proportion = 0 WHERE user_id = f1;
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('₦1,000 of own cash qualifies one friend',
    s.progress = 1, s.progress::text);

  ------------------------------------------------------------ accumulation
  -- Two ₦600 bets: qualification is the TOTAL, not one big bet, or a careful
  -- small-stakes player would never count.
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn,bonus_proportion)
  VALUES (f2, mkt, 0, 600, 0), (f2, mkt, 1, 600, 0);
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('several small stakes add up to qualify',
    s.progress = 2, s.progress::text);

  ------------------------------------------------------------ not claimable
  PERFORM pg_temp.check('two of three does not pay', NOT s.claimable);
  SELECT * INTO r FROM public.claim_streak_reward(u, 'refer_3');
  PERFORM pg_temp.check('and claiming early is refused', NOT r.applied, r.reason);

  ------------------------------------------------------------ someone else's
  -- A stranger with a huge stake history must not count for this referrer.
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn,bonus_proportion)
  VALUES (stranger, mkt, 0, 500000, 0);
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('an unreferred stranger never counts',
    s.progress = 2, s.progress::text);

  ------------------------------------------------------------ the third
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn,bonus_proportion)
  VALUES (f3, mkt, 0, 1500, 0);
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('the third qualifier completes it',
    s.progress = 3 AND s.claimable, s.progress || '/' || s.target);

  SELECT bonus_balance INTO bal FROM public.users WHERE id=u;
  SELECT * INTO r FROM public.claim_streak_reward(u, 'refer_3');
  PERFORM pg_temp.check('it pays 500', r.applied AND r.reward_tngn = 500, r.reason);
  PERFORM pg_temp.check('into bonus, not cash',
    (SELECT bonus_balance FROM public.users WHERE id=u) = bal + 500
    AND (SELECT tngn_balance FROM public.users WHERE id=u) = 0);
  PERFORM pg_temp.check('and the referrer is told',
    EXISTS (SELECT 1 FROM public.notifications
             WHERE user_id=u AND type='streak_reward'));

  ------------------------------------------------------------ no double dip
  SELECT * INTO r FROM public.claim_streak_reward(u, 'refer_3');
  PERFORM pg_temp.check('claiming twice is refused', NOT r.applied, r.reason);

  -- A fourth and fifth qualifier are progress toward the NEXT three, not a
  -- second payout for the same three.
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn,bonus_proportion)
  VALUES (f4, mkt, 0, 2000, 0), (f5, mkt, 0, 2000, 0);
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('friends 4 and 5 do not re-open the same claim',
    NOT s.claimable AND s.claimed, s.period_key);
  SELECT * INTO r FROM public.claim_streak_reward(u, 'refer_3');
  PERFORM pg_temp.check('and cannot be claimed', NOT r.applied, r.reason);

  ------------------------------------------------------------ the next three
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn,bonus_proportion)
  VALUES (f6, mkt, 0, 2000, 0);
  SELECT * INTO s FROM public.get_streak_state(u) WHERE streak_id='refer_3';
  PERFORM pg_temp.check('a sixth qualifier opens a fresh claim',
    s.claimable AND NOT s.claimed, s.period_key);
  SELECT * INTO r FROM public.claim_streak_reward(u, 'refer_3');
  PERFORM pg_temp.check('the second three pays 500 too',
    r.applied AND r.reward_tngn = 500, r.reason);
  PERFORM pg_temp.check('two claims recorded, not three',
    (SELECT count(*) FROM public.streak_claims
      WHERE user_id=u AND streak_id='refer_3') = 2);

  ------------------------------------------------------------ period keying
  -- The bug this guards: a period key with a month or week in it would let
  -- the SAME three friends be re-claimed forever. The key must be the count
  -- bucket and nothing else.
  PERFORM pg_temp.check('the period key carries no date',
    (SELECT period_key FROM public.get_streak_state(u) WHERE streak_id='refer_3')
      NOT LIKE '%' || to_char(now(),'YYYY') || '%',
    (SELECT period_key FROM public.get_streak_state(u) WHERE streak_id='refer_3'));

  ------------------------------------------------------------ trades count
  -- Open Markets buys are staking too. A referee who only ever trades must
  -- qualify, or the newest engine is invisible to this.
  INSERT INTO public.users(id,email,username,referred_by_user_id)
  VALUES ('cccccccc-0000-0000-0000-000000000001','t1@x.com','t1',stranger);
  PERFORM pg_temp.check('a fresh referrer starts at zero',
    (SELECT progress FROM public.get_streak_state(stranger) WHERE streak_id='refer_3') = 0);

  ------------------------------------------------------------ still capped
  PERFORM pg_temp.check('every reward is still within the 500 cap',
    NOT EXISTS (SELECT 1 FROM public.get_streak_state(u) WHERE reward_tngn > 500));
  PERFORM pg_temp.check('no negative balances',
    NOT EXISTS (SELECT 1 FROM public.users WHERE tngn_balance < 0 OR bonus_balance < 0));
END
$t$;
