-- Solo operator mode.
--
-- Written as the two attacks that matter, mirroring open_markets_house_
-- market.sql's own style: "a control can be relaxed" is only meaningful if
-- the test tries to relax it in the ONE way that must never work.
--
--   Attack A: does solo mode accidentally let a CREATOR self-approve or
--   self-resolve a market they earn a fee share on? (It must not — that is
--   the exact insider-trading hole 20260807040000 closed, and solo mode is
--   scoped to house markets only.)
--
--   Attack B: does solo mode accidentally weaken the "submitter cannot
--   trade their own market" guard? (It must not — that guard protects OTHER
--   people's money, has nothing to do with how many admins exist, and this
--   migration never touches execute_open_trade.)
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
  solo    uuid := '11111111-1111-1111-1111-111111111111';  -- the one admin
  other   uuid := '22222222-2222-2222-2222-222222222222';
  punter  uuid := '33333333-3333-3333-3333-333333333333';
  house_mkt    uuid;
  creator_mkt  uuid;
  r record;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES
    (solo  ,'solo@x.com'  ,'solo'  , 500000),
    (other ,'other@x.com' ,'other' , 500000),
    (punter,'punt@x.com'  ,'punter', 500000);

  ------------------------------------------------------------- default off
  PERFORM pg_temp.check('solo mode defaults off',
    NOT (SELECT solo_operator_mode FROM public.open_markets_config WHERE id=1));

  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL,
    p_question => 'Will the Senate pass the finance bill this quarter?',
    p_description => NULL, p_category => 'politics',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'National Assembly',
    p_trading_closes_at => now() + interval '30 days',
    p_submitted_by => solo);
  house_mkt := r.market_id;

  SELECT * INTO r FROM public.review_open_market(
    house_mkt, solo, 'approve', 12::smallint, NULL, NULL, 'ok', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('OFF: submitter still cannot approve own house market',
    NOT r.applied, r.reason);

  ------------------------------------------------------------------ toggle
  BEGIN
    PERFORM public.set_open_markets_solo_mode(NULL, true);
    PERFORM pg_temp.check('toggle refuses a NULL admin id', false, 'ACCEPTED');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('toggle refuses a NULL admin id', true, SQLERRM);
  END;

  PERFORM public.set_open_markets_solo_mode(solo, true);
  PERFORM pg_temp.check('solo mode is now on',
    (SELECT solo_operator_mode FROM public.open_markets_config WHERE id=1));
  PERFORM pg_temp.check('who turned it on is recorded',
    (SELECT solo_operator_set_by FROM public.open_markets_config WHERE id=1) = solo);
  PERFORM pg_temp.check('and when',
    (SELECT solo_operator_set_at FROM public.open_markets_config WHERE id=1) IS NOT NULL);

  ------------------------------------------------------- house market: allow
  SELECT * INTO r FROM public.review_open_market(
    house_mkt, solo, 'approve', 12::smallint, NULL, NULL, 'ok', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('ON: submitter CAN now approve their own house market',
    r.applied, r.reason);
  PERFORM pg_temp.check('and it is stamped self_reviewed',
    (SELECT self_reviewed FROM public.open_markets WHERE id=house_mkt));
  PERFORM pg_temp.check('the market genuinely opened',
    (SELECT status FROM public.open_markets WHERE id=house_mkt) = 'open');

  ----------------------------------------------- attack A: creator, not house
  -- A market with a REAL creator (fee share) — the exact configuration solo
  -- mode must never touch, even while it is switched on.
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => solo,
    p_question => 'Will Naira strengthen past 1000/USD this quarter?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'CBN',
    p_trading_closes_at => now() + interval '30 days',
    p_submitted_by => solo);
  creator_mkt := r.market_id;

  SELECT * INTO r FROM public.review_open_market(
    creator_mkt, solo, 'approve', 12::smallint, NULL, NULL, 'ok', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('ATTACK A: solo mode does NOT let a creator self-approve',
    NOT r.applied, r.reason);

  -- A different admin still can, same as always.
  SELECT * INTO r FROM public.review_open_market(
    creator_mkt, other, 'approve', 12::smallint, NULL, NULL, 'ok', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('a different admin can still approve the creator market',
    r.applied, r.reason);
  PERFORM pg_temp.check('and that is NOT stamped self_reviewed — a real second person looked',
    NOT (SELECT self_reviewed FROM public.open_markets WHERE id=creator_mkt));

  --------------------------------------------------- attack B: trading, still
  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), house_mkt, solo, 0, 1000, 1e9);
    PERFORM pg_temp.check('ATTACK B: solo mode does NOT let the submitter trade their own market',
      false, 'trade went through!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('ATTACK B: solo mode does NOT let the submitter trade their own market',
      true, SQLERRM);
  END;
  PERFORM public.execute_open_trade(gen_random_uuid(), house_mkt, punter, 0, 1000, 1e9);
  PERFORM pg_temp.check('an ordinary user can still trade it',
    (SELECT shares_cash FROM public.open_positions
      WHERE market_id=house_mkt AND user_id=punter) = 1000);

  --------------------------------------------------------- resolve: house
  UPDATE public.open_markets SET status='closed', trading_closes_at = now() - interval '1 minute'
   WHERE id = house_mkt;

  SELECT * INTO r FROM public.settle_open_market(house_mkt, 0, solo, solo, 'http://na.gov.ng', true);
  PERFORM pg_temp.check('ON: one person CAN be both resolver and confirmer on a house market',
    r.reason = 'dry_run', r.reason);

  SELECT * INTO r FROM public.settle_open_market(house_mkt, 0, solo, solo, 'http://na.gov.ng', false);
  PERFORM pg_temp.check('and applying it for real works',
    r.applied, r.reason);
  PERFORM pg_temp.check('stamped self_resolved',
    (SELECT self_resolved FROM public.open_markets WHERE id=house_mkt));

  --------------------------------------------------- resolve: creator, never
  UPDATE public.open_markets SET status='closed', trading_closes_at = now() - interval '1 minute'
   WHERE id = creator_mkt;

  SELECT * INTO r FROM public.settle_open_market(creator_mkt, 0, solo, solo, 'http://cbn', true);
  PERFORM pg_temp.check('ATTACK A cont''d: solo mode does NOT allow single-signature resolve on a creator market',
    NOT r.applied, r.reason);

  SELECT * INTO r FROM public.settle_open_market(creator_mkt, 0, solo, other, 'http://cbn', true);
  PERFORM pg_temp.check('...nor does it let the creator be either signature, even paired with someone real',
    NOT r.applied, r.reason);

  -- Two genuinely different, uninvolved people still can.
  SELECT * INTO r FROM public.settle_open_market(creator_mkt, 0, other, punter, 'http://cbn', false);
  PERFORM pg_temp.check('two real, uninvolved people can still resolve the creator market',
    r.applied, r.reason);
  PERFORM pg_temp.check('and that is NOT stamped self_resolved',
    NOT (SELECT self_resolved FROM public.open_markets WHERE id=creator_mkt));

  --------------------------------------------------------------- turn it off
  PERFORM public.set_open_markets_solo_mode(solo, false);
  PERFORM pg_temp.check('turning it back off is recorded too',
    (SELECT solo_operator_set_by FROM public.open_markets_config WHERE id=1) = solo
    AND NOT (SELECT solo_operator_mode FROM public.open_markets_config WHERE id=1));

  -- A fresh house market, submitted and self-reviewed attempted again — must
  -- refuse exactly like it did before solo mode ever existed.
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => NULL,
    p_question => 'Will the next MPC meeting hold rates steady this time?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Hold','Change'], p_resolution_source => 'CBN',
    p_trading_closes_at => now() + interval '30 days',
    p_submitted_by => solo);
  SELECT * INTO r FROM public.review_open_market(
    r.market_id, solo, 'approve', 12::smallint, NULL, NULL, 'ok', 'starter',
    now() + interval '30 days', NULL);
  PERFORM pg_temp.check('OFF again: self-approval is refused exactly as before',
    NOT r.applied, r.reason);
END
$t$;
