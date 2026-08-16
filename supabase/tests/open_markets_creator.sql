-- Creator earnings and disputes.
--
-- Both move or block real money: claim_creator_earnings pays out of the house
-- reserve, and a dispute freezes payouts for everyone in a market. So both are
-- tested for who is allowed to call them, not only that they work.
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
  admin2  uuid := '55555555-5555-5555-5555-555555555555';
  alice   uuid := '33333333-3333-3333-3333-333333333333';
  bob     uuid := '44444444-4444-4444-4444-444444444444';
  stranger uuid := '77777777-7777-7777-7777-777777777777';
  mkt uuid; r record; bal numeric; n integer; i integer;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES
    (creator,'c@x.com','creator',0), (admin,'a@x.com','admin',0),
    (admin2,'a2@x.com','admin2',0), (alice,'al@x.com','alice',5000000),
    (bob,'b@x.com','bob',5000000), (stranger,'s@x.com','stranger',1000);

  SELECT market_id INTO mkt FROM public.submit_open_market(
    creator, 'Will the naira close below 1500 to the dollar this quarter?', NULL,
    'economy', ARRAY['Yes','No'], 'CBN', NULL, NULL, now() + interval '30 days');
  PERFORM public.review_open_market(mkt, admin, 'approve', 12::smallint, NULL, NULL,
    'ok', 'starter', now() + interval '30 days', NULL);

  ------------------------------------------------------------------ nothing yet
  SELECT * INTO r FROM public.claim_creator_earnings(mkt, creator);
  PERFORM pg_temp.check('nothing to claim before the threshold', NOT r.applied, r.reason);

  -- Not your market.
  SELECT * INTO r FROM public.claim_creator_earnings(mkt, stranger);
  PERFORM pg_temp.check('a stranger cannot claim', NOT r.applied, r.reason);

  ------------------------------------------------------------------ trade past it
  -- The real threshold is b*ln(2) = ~6,931 in FEES, which at a 1.5% fee needs
  -- around half a million naira of volume — and the position cap (0.5*b, so
  -- 5,000 shares of one outcome per account) means no small set of test users
  -- can reach it by accumulating. That the threshold EQUALS b*ln(N) is already
  -- covered in the review suite; what needs testing here is the claim
  -- mechanism, so the bar is lowered before any trading happens.
  --
  -- Lowered BEFORE, deliberately: creator_accrued is computed on the trade
  -- path against the threshold as it stands at that moment, so moving it
  -- afterwards would leave the counter and the replay disagreeing and the test
  -- would be exercising the corruption guard instead of the happy path.
  UPDATE public.open_markets SET threshold_tngn = 100 WHERE id = mkt;

  -- Round trips rather than accumulation: both legs pay a fee, and the
  -- position returns to zero so the cap never binds.
  FOR i IN 1..4 LOOP
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, alice, 0,  4000, 1e9);
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, alice, 0, -4000, -1e9);
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, bob,   1,  4000, 1e9);
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, bob,   1, -4000, -1e9);
  END LOOP;

  -- Alice keeps a real holding so she has standing to dispute later.
  PERFORM public.execute_open_trade(gen_random_uuid(), mkt, alice, 0, 2000, 1e9);

  PERFORM pg_temp.check('fees passed the threshold',
    (SELECT fees_collected > threshold_tngn FROM public.open_markets WHERE id=mkt),
    (SELECT round(fees_collected,2) || ' vs ' || round(threshold_tngn,2)
       FROM public.open_markets WHERE id=mkt));
  PERFORM pg_temp.check('creator accrued something',
    (SELECT creator_accrued FROM public.open_markets WHERE id=mkt) > 0,
    (SELECT round(creator_accrued,2)::text FROM public.open_markets WHERE id=mkt));

  ------------------------------------------------------------------ claim
  SELECT tngn_balance INTO bal FROM public.users WHERE id=creator;
  SELECT * INTO r FROM public.claim_creator_earnings(mkt, creator);
  PERFORM pg_temp.check('creator is paid', r.applied, round(r.paid_tngn,2) || ' paid');
  PERFORM pg_temp.check('the money actually arrived',
    (SELECT tngn_balance FROM public.users WHERE id=creator) = bal + r.paid_tngn);

  -- Two taps must not pay twice.
  SELECT * INTO r FROM public.claim_creator_earnings(mkt, creator);
  PERFORM pg_temp.check('a second claim pays nothing', NOT r.applied, r.reason);

  PERFORM pg_temp.check('paid never exceeds accrued',
    (SELECT creator_paid <= creator_accrued FROM public.open_markets WHERE id=mkt));
  PERFORM pg_temp.check('accrual still matches a replay of the fee log',
    public.open_market_book_ok(mkt),
    (SELECT COALESCE(string_agg(check_name,', '),'none')
       FROM public.verify_open_market_book(mkt) WHERE NOT ok));

  -- A corrupted counter must under-pay, never over-pay: the replay is the
  -- authority, not the cached running total.
  UPDATE public.open_markets SET creator_accrued = creator_accrued * 1000 WHERE id=mkt;
  SELECT * INTO r FROM public.claim_creator_earnings(mkt, creator);
  PERFORM pg_temp.check('an inflated counter cannot be cashed out',
    NOT r.applied OR r.paid_tngn < 1000, r.reason || ' ' || COALESCE(round(r.paid_tngn,2)::text,''));
  UPDATE public.open_markets SET creator_accrued = creator_accrued / 1000 WHERE id=mkt;

  ------------------------------------------------------------------ disputes
  SELECT * INTO r FROM public.raise_open_market_dispute(mkt, alice, 'This is wrong because of X');
  PERFORM pg_temp.check('cannot dispute a market still trading', NOT r.applied, r.reason);

  UPDATE public.open_markets SET status='closed', trading_closes_at=now()-interval '1 minute'
   WHERE id=mkt;
  PERFORM public.settle_open_market(mkt, 0, admin, admin2, 'http://cbn', false);

  SELECT * INTO r FROM public.raise_open_market_dispute(mkt, alice, 'short');
  PERFORM pg_temp.check('a one-word dispute is refused', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.raise_open_market_dispute(
    mkt, stranger, 'I think the CBN print says otherwise entirely');
  PERFORM pg_temp.check('someone who never traded cannot dispute', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.raise_open_market_dispute(
    mkt, alice, 'The CBN print for that date says the opposite of this');
  PERFORM pg_temp.check('a holder can dispute', r.applied, r.reason);

  SELECT * INTO r FROM public.raise_open_market_dispute(
    mkt, alice, 'Saying the same thing a second time to double up');
  PERFORM pg_temp.check('no duplicate open disputes', NOT r.applied, r.reason);

  -- The point of the button: an open dispute must actually stop the money.
  UPDATE public.open_markets SET settlement_locked_until = now() - interval '1 minute'
   WHERE id = mkt;
  BEGIN
    PERFORM public.release_open_settlements(mkt, 250, false);
    PERFORM pg_temp.check('an open dispute blocks release', false, 'released anyway!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('an open dispute blocks release', true, SQLERRM);
  END;

  UPDATE public.open_market_disputes SET status='rejected', ruled_at=now()
   WHERE market_id=mkt AND status='open';
  SELECT * INTO r FROM public.release_open_settlements(mkt, 250, false);
  PERFORM pg_temp.check('release resumes once it is ruled on', r.released > 0,
    r.released || ' released');

  -- Too late to dispute once the money is in wallets.
  SELECT * INTO r FROM public.raise_open_market_dispute(
    mkt, bob, 'I want to complain now that everyone has been paid out');
  PERFORM pg_temp.check('cannot dispute after payout', NOT r.applied, r.reason);

  PERFORM pg_temp.check('no negative balances anywhere',
    NOT EXISTS (SELECT 1 FROM public.users WHERE tngn_balance < 0 OR bonus_balance < 0));
END
$t$;
