-- purge_unstaked_auto_fetched_markets.
--
-- The one rule this function exists to enforce: NOTHING with real activity on
-- it gets touched, no matter how many rows are queued up for deletion. Every
-- table that can hold a market_id reference gets its own case here, because
-- missing even one would mean silently destroying a user's history or (worse)
-- hitting the FK and aborting a 500-row cleanup on the first surprise.
\set ON_ERROR_STOP on
\pset pager off

-- Extra tables this suite needs that no other suite does. Minimal stand-ins,
-- same principle as _base.sql: only the columns the function under test
-- actually reads.
CREATE TABLE IF NOT EXISTS public.multiplier_slips(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE IF NOT EXISTS public.multiplier_legs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_id uuid NOT NULL REFERENCES public.multiplier_slips(id) ON DELETE CASCADE,
  market_id bigint NOT NULL REFERENCES public.markets(id));
CREATE TABLE IF NOT EXISTS public.vip_referral_earnings(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vip_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bet_id uuid NOT NULL,
  market_id bigint NOT NULL REFERENCES public.markets(id));
CREATE TABLE IF NOT EXISTS public.bet_insurance_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bet_id uuid NOT NULL,
  market_id bigint NOT NULL REFERENCES public.markets(id),
  refund_amount_tngn numeric NOT NULL,
  trigger_reason text NOT NULL);
CREATE TABLE IF NOT EXISTS public.merkle_commits(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id bigint NOT NULL REFERENCES public.markets(id),
  bet_count integer DEFAULT 0);

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 58), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 58), detail;
  END IF;
END$$;

DO $t$
DECLARE
  u uuid := '11111111-1111-1111-1111-111111111111';
  v uuid := '22222222-2222-2222-2222-222222222222';
  m_untouched      bigint;  -- auto-fetched, zero activity — must go
  m_admin          bigint;  -- fixture_id NULL — never a candidate
  m_has_bet        bigint;  -- auto-fetched, one user_bets row — must survive
  m_has_leg        bigint;  -- auto-fetched, one multiplier_legs row — survive
  m_has_vip        bigint;  -- vip_referral_earnings row — survive
  m_has_insurance  bigint;  -- bet_insurance_events row — survive
  m_has_merkle     bigint;  -- merkle_commits row, real bet_count — survive
  m_zero_lock      bigint;  -- merkle_commits row, bet_count 0 (routine lock) — must go
  parent_clean     bigint;  -- parent whose only child is itself unstaked
  child_clean      bigint;
  parent_dirty     bigint;  -- parent whose child HAS a bet
  child_dirty      bigint;
  slip             uuid;
  before_count integer;
  after_count  integer;
  v_balance_before numeric;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES (u,'a@x.com','alpha',10000,0), (v,'b@x.com','beta',10000,0);
  INSERT INTO public.multiplier_slips(id) VALUES (gen_random_uuid()) RETURNING id INTO slip;

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Untouched fixture',9001,NULL) RETURNING id INTO m_untouched;

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Admin-made, no fixture id',NULL,NULL) RETURNING id INTO m_admin;

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Has a real bet',9002,NULL) RETURNING id INTO m_has_bet;
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn)
  VALUES (u,m_has_bet,0,500);

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Used as a Multiplier leg',9003,NULL) RETURNING id INTO m_has_leg;
  INSERT INTO public.multiplier_legs(slip_id,market_id) VALUES (slip,m_has_leg);

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Paid a VIP referrer',9004,NULL) RETURNING id INTO m_has_vip;
  INSERT INTO public.vip_referral_earnings(vip_user_id,referred_user_id,bet_id,market_id)
  VALUES (u,v,gen_random_uuid(),m_has_vip);

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Triggered bet insurance',9005,NULL) RETURNING id INTO m_has_insurance;
  INSERT INTO public.bet_insurance_events(user_id,bet_id,market_id,refund_amount_tngn,trigger_reason)
  VALUES (u,gen_random_uuid(),m_has_insurance,200,'first_bet');

  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Has an on-chain commit',9006,NULL) RETURNING id INTO m_has_merkle;
  INSERT INTO public.merkle_commits(market_id,bet_count) VALUES (m_has_merkle, 3);

  -- The false positive that hit production: /api/markets/lock writes a
  -- merkle_commits row for EVERY market that reaches its close time, whether
  -- or not anyone ever staked on it. bet_count is 0 in that case. The very
  -- first real run of this function protected 729 of 765 candidates almost
  -- entirely on this signal — a market that simply ran its course untouched,
  -- not one anyone had money on.
  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Locked with zero bets, like most of the backlog',9010,NULL) RETURNING id INTO m_zero_lock;
  INSERT INTO public.merkle_commits(market_id,bet_count) VALUES (m_zero_lock, 0);

  -- A clean parent/child pair: neither has activity.
  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Clean parent',9007,NULL) RETURNING id INTO parent_clean;
  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Clean child (BTTS)',9007,parent_clean) RETURNING id INTO child_clean;

  -- A parent whose child has a real bet: the PARENT itself has none, but the
  -- group is not "clean" — the parent must be left alone too, or its display
  -- would point at a child with money on it and no context.
  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Parent of a staked child',9008,NULL) RETURNING id INTO parent_dirty;
  INSERT INTO public.markets(question,fixture_id,parent_market_id)
  VALUES ('Staked child (BTTS)',9008,parent_dirty) RETURNING id INTO child_dirty;
  INSERT INTO public.user_bets(user_id,market_id,outcome_index,stake_tngn)
  VALUES (v,child_dirty,1,300);

  before_count := (SELECT count(*) FROM public.markets);
  -- Not debited by this harness (the raw INSERT above bypasses place_bet, so
  -- nothing touches the balance) — captured as a baseline so the check below
  -- proves the purge itself moves nothing, independent of what did or did not
  -- debit it on the way in.
  v_balance_before := (SELECT tngn_balance FROM public.users WHERE id=u);

  ------------------------------------------------------------- dry run first
  SELECT count(*) INTO before_count FROM public.markets; -- re-snapshot post-setup
  PERFORM * FROM public.purge_unstaked_auto_fetched_markets(true); -- warm the plan
  PERFORM pg_temp.check('a dry run deletes nothing',
    (SELECT count(*) FROM public.markets) = before_count);

  SELECT sum(deleted) INTO after_count
    FROM public.purge_unstaked_auto_fetched_markets(true)
   WHERE phase IN ('sub-markets','parents');
  PERFORM pg_temp.check('dry run reports exactly the three clean rows',
    after_count = 3, after_count::text);

  ------------------------------------------------------------------ the run
  before_count := (SELECT count(*) FROM public.markets);
  PERFORM * FROM public.purge_unstaked_auto_fetched_markets(false);

  PERFORM pg_temp.check('the untouched auto-fetched market is gone',
    NOT EXISTS (SELECT 1 FROM public.markets WHERE id = m_untouched));
  PERFORM pg_temp.check('admin-made (no fixture_id) was never a candidate — still here',
    EXISTS (SELECT 1 FROM public.markets WHERE id = m_admin));

  ------------------------------------------------------- the five guards
  PERFORM pg_temp.check('a market with a real bet survives',
    EXISTS (SELECT 1 FROM public.markets WHERE id = m_has_bet));
  PERFORM pg_temp.check('a market used as a Multiplier leg survives',
    EXISTS (SELECT 1 FROM public.markets WHERE id = m_has_leg));
  PERFORM pg_temp.check('a market that paid a VIP referrer survives',
    EXISTS (SELECT 1 FROM public.markets WHERE id = m_has_vip));
  PERFORM pg_temp.check('a market that triggered bet insurance survives',
    EXISTS (SELECT 1 FROM public.markets WHERE id = m_has_insurance));
  PERFORM pg_temp.check('a market with an on-chain commit survives',
    EXISTS (SELECT 1 FROM public.markets WHERE id = m_has_merkle));
  PERFORM pg_temp.check('but a routine lock commit with zero bets does NOT protect it — the production bug',
    NOT EXISTS (SELECT 1 FROM public.markets WHERE id = m_zero_lock));

  ------------------------------------------------------- parent/child logic
  PERFORM pg_temp.check('a clean parent+child pair is fully cleared',
    NOT EXISTS (SELECT 1 FROM public.markets WHERE id IN (parent_clean, child_clean)));
  PERFORM pg_temp.check('a parent whose child is staked survives',
    EXISTS (SELECT 1 FROM public.markets WHERE id = parent_dirty));
  PERFORM pg_temp.check('and so does the staked child itself',
    EXISTS (SELECT 1 FROM public.markets WHERE id = child_dirty));

  ------------------------------------------------------- money untouched
  PERFORM pg_temp.check('nobody''s balance moved — this purge refunds nothing',
    (SELECT tngn_balance FROM public.users WHERE id=u) = v_balance_before
    AND (SELECT bonus_balance FROM public.users WHERE id=u) = 0);
  PERFORM pg_temp.check('the surviving bet itself is untouched',
    (SELECT status FROM public.user_bets WHERE market_id=m_has_bet) = 'active');

  ------------------------------------------------------------------ idempotent
  after_count := (SELECT count(*) FROM public.markets);
  PERFORM * FROM public.purge_unstaked_auto_fetched_markets(false);
  PERFORM pg_temp.check('running it again is a clean no-op',
    (SELECT count(*) FROM public.markets) = after_count, after_count::text);

  ------------------------------------------------------------------ report
  SELECT count(*) INTO after_count FROM public.markets m
   WHERE m.fixture_id IS NOT NULL AND public._auto_fetched_market_has_activity(m.id);
  PERFORM pg_temp.check('phase 3 reports exactly the survivors',
    (SELECT candidates FROM public.purge_unstaked_auto_fetched_markets(true)
      WHERE phase = 'left in place — has real activity') = after_count,
    after_count::text);
END
$t$;
