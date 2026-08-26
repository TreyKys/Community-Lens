-- Profile rewards: phone and social follows.
--
-- Written around the two things that decide whether this costs money it
-- shouldn't: a reward paid twice, and the phone reward paying out for a number
-- nobody ever verified.
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
  r record; bal numeric;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES (u,'a@x.com','alpha',0,0), (v,'b@x.com','beta',0,0);

  ------------------------------------------------------------------ catalogue
  PERFORM pg_temp.check('five rewards in the catalogue',
    (SELECT count(*) FROM public.reward_catalogue()) = 5);
  PERFORM pg_temp.check('socials are ₦100',
    (SELECT count(*) FROM public.reward_catalogue()
      WHERE reward_id <> 'phone' AND reward_tngn = 100) = 4);
  -- The phone reward is OFF. There is no SMS provider, so the verification it
  -- was contingent on cannot happen, and a reward that cannot pay is a debt
  -- rather than a promotion.
  PERFORM pg_temp.check('the phone reward pays nothing',
    (SELECT reward_tngn FROM public.reward_catalogue() WHERE reward_id='phone') = 0);
  PERFORM pg_temp.check('but the phone row is still offered',
    EXISTS (SELECT 1 FROM public.reward_catalogue() WHERE reward_id='phone'));
  PERFORM pg_temp.check('and it no longer promises anything',
    (SELECT detail FROM public.reward_catalogue() WHERE reward_id='phone')
      NOT LIKE '%₦%');
  PERFORM pg_temp.check('everything on offer together caps at ₦400',
    (SELECT COALESCE(SUM(reward_tngn),0) FROM public.reward_catalogue()) = 400);

  ------------------------------------------------------------------ phone
  SELECT * INTO r FROM public.claim_profile_reward(u, 'phone', NULL, NULL);
  PERFORM pg_temp.check('phone claim needs a number', NOT r.applied, r.reason);

  SELECT bonus_balance INTO bal FROM public.users WHERE id=u;
  SELECT * INTO r FROM public.claim_profile_reward(u, 'phone', NULL, '08031234567');
  PERFORM pg_temp.check('phone claim is accepted', r.applied, r.reason);
  PERFORM pg_temp.check('the number is stored — that was the whole point',
    (SELECT phone FROM public.users WHERE id=u) = '08031234567');

  -- Everything below is the zero-value path behaving like a record rather than
  -- a payment. Each of these was a real way for ₦0 to look like money.
  PERFORM pg_temp.check('it settles terminally, nothing left pending',
    r.status = 'paid', r.status);
  PERFORM pg_temp.check('nothing pending anywhere for this user',
    NOT EXISTS (SELECT 1 FROM public.profile_rewards
                 WHERE user_id=u AND status='pending'));
  PERFORM pg_temp.check('it reports ₦0, not the old ₦200',
    r.reward_tngn = 0, r.reward_tngn::text);
  PERFORM pg_temp.check('no balance moved',
    (SELECT bonus_balance FROM public.users WHERE id=u) = bal);
  PERFORM pg_temp.check('no ₦0 treasury row was written',
    NOT EXISTS (SELECT 1 FROM public.treasury_log
                 WHERE user_id=u AND type='profile_reward'));
  PERFORM pg_temp.check('and nobody was told "₦0 bonus added"',
    NOT EXISTS (SELECT 1 FROM public.notifications
                 WHERE user_id=u AND type='profile_reward'));

  -- Same number on a second account must be refused. This is the cheapest
  -- brake there is on one person signing up ten times.
  SELECT * INTO r FROM public.claim_profile_reward(v, 'phone', NULL, '08031234567');
  PERFORM pg_temp.check('a number cannot be reused on another account',
    NOT r.applied, r.reason);
  PERFORM pg_temp.check('the refusal does not confirm the number exists',
    r.reason NOT ILIKE '%already%registered%' AND r.reason NOT ILIKE '%taken%', r.reason);

  ------------------------------------------------------------------ release
  -- The release path is deliberately still here and still callable, so that
  -- restoring the reward later is a number change rather than a rebuild. With
  -- nothing pending it must be a clean no-op — not an error, and above all not
  -- a payment.
  SELECT bonus_balance INTO bal FROM public.users WHERE id=u;
  SELECT * INTO r FROM public.release_verified_phone_reward(u);
  PERFORM pg_temp.check('releasing finds nothing to release', NOT r.applied);
  PERFORM pg_temp.check('and pays nothing',
    (SELECT bonus_balance FROM public.users WHERE id=u) = bal);
  PERFORM pg_temp.check('the row stays paid',
    (SELECT status FROM public.profile_rewards
      WHERE user_id=u AND reward_id='phone') = 'paid');

  SELECT * INTO r FROM public.release_verified_phone_reward(u);
  PERFORM pg_temp.check('a second call still pays nothing', NOT r.applied);
  PERFORM pg_temp.check('still exactly one phone reward row',
    (SELECT count(*) FROM public.profile_rewards
      WHERE user_id=u AND reward_id='phone') = 1);

  ------------------------------------------------------------------ socials
  SELECT * INTO r FROM public.claim_profile_reward(u, 'x_opinions', NULL, NULL);
  PERFORM pg_temp.check('a social claim needs a handle', NOT r.applied, r.reason);

  SELECT bonus_balance INTO bal FROM public.users WHERE id=u;
  SELECT * INTO r FROM public.claim_profile_reward(u, 'x_opinions', '@alpha', NULL);
  PERFORM pg_temp.check('social claim pays immediately',
    r.applied AND r.status = 'paid' AND r.reward_tngn = 100, r.reason);
  PERFORM pg_temp.check('credited to bonus',
    (SELECT bonus_balance FROM public.users WHERE id=u) = bal + 100);
  -- The handle is the entire audit trail, since nothing can check the follow.
  PERFORM pg_temp.check('the stated handle is recorded for audit',
    (SELECT handle FROM public.profile_rewards
      WHERE user_id=u AND reward_id='x_opinions') = '@alpha');

  SELECT * INTO r FROM public.claim_profile_reward(u, 'x_opinions', '@alpha', NULL);
  PERFORM pg_temp.check('the same social cannot be claimed twice',
    NOT r.applied, r.reason);

  SELECT * INTO r FROM public.claim_profile_reward(u, 'not_a_reward', '@x', NULL);
  PERFORM pg_temp.check('an unknown reward id is refused', NOT r.applied, r.reason);

  ------------------------------------------------------------------ totals
  -- Claim everything available and check the ceiling holds.
  PERFORM public.claim_profile_reward(u, 'ig_opinions', '@alpha', NULL);
  PERFORM public.claim_profile_reward(u, 'x_neuro',     '@alpha', NULL);
  PERFORM public.claim_profile_reward(u, 'ig_neuro',    '@alpha', NULL);
  -- ₦400, not the ₦600 this used to be: the phone reward is off, so the most
  -- a brand-new account can extract from this card is the four social claims.
  -- This is the number that bounds the whole feature's exposure per signup.
  PERFORM pg_temp.check('everything claimed totals ₦400, not more',
    (SELECT bonus_balance FROM public.users WHERE id=u) = 400,
    (SELECT bonus_balance FROM public.users WHERE id=u)::text);

  PERFORM pg_temp.check('state reflects what was claimed',
    (SELECT count(*) FROM public.get_reward_state(u) WHERE status = 'paid') = 5);
  PERFORM pg_temp.check('a fresh account sees all five available',
    (SELECT count(*) FROM public.get_reward_state(v) WHERE status = 'available') = 5);

  PERFORM pg_temp.check('no cash was ever paid',
    (SELECT tngn_balance FROM public.users WHERE id=u) = 0);
  PERFORM pg_temp.check('no negative balances',
    NOT EXISTS (SELECT 1 FROM public.users WHERE tngn_balance < 0 OR bonus_balance < 0));
END
$t$;
