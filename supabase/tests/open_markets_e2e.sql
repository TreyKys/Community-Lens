-- End-to-end: submit -> review -> approve -> trade -> quote -> sell ->
-- horizon -> resolve -> release. Money is checked at every hop, because a
-- lifecycle test that only asserts "no exception" would pass on a book that
-- silently minted naira.
\set ON_ERROR_STOP on
\timing off
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 44), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 44), detail;
  END IF;
END$$;

-- Total naira in the system. Three places it can sit, and all three must be
-- counted or the invariant is measuring the wrong thing:
--
--   1. user wallets
--   2. house_reserve
--   3. IN FLIGHT INSIDE AN LMSR BOOK — cash traders have paid in that has not
--      yet been paid out as a settlement, nor swept into the reserve as fees.
--
-- (3) has no ledger row of its own. The trade path deliberately does not touch
-- house_reserve (that deadlocked against settle_multiplier_market and
-- serialised every trade on one row), so between a trade and its settlement
-- the money is real but unattributed. Counting only (1)+(2) makes every
-- healthy market look like it is leaking.
CREATE OR REPLACE FUNCTION pg_temp.money() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT (SELECT COALESCE(SUM(tngn_balance + bonus_balance),0) FROM public.users)
       + (SELECT COALESCE(total_tngn,0) FROM public.house_reserve WHERE id=1)
       + (SELECT COALESCE(SUM(paid_cash + paid_bonus),0) FROM public.open_trades)
       - (SELECT COALESCE(SUM(tngn + bonus),0) FROM public.open_settlements
           WHERE released_at IS NOT NULL)
       - (SELECT COALESCE(SUM(fees_swept),0) FROM public.open_markets)
$$;

DO $e2e$
DECLARE
  creator uuid := '11111111-1111-1111-1111-111111111111';
  admin   uuid := '22222222-2222-2222-2222-222222222222';
  alice   uuid := '33333333-3333-3333-3333-333333333333';
  bob     uuid := '44444444-4444-4444-4444-444444444444';
  carol   uuid := '66666666-6666-6666-6666-666666666666';
  mkt     uuid;
  r       record;
  qt      record;
  t       record;
  money0  numeric;
  bal     numeric;
  spent   numeric;
  proceeds numeric;
  shares  numeric;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance) VALUES
    (creator,'c@x.com','creator',0),
    (admin,'a@x.com','admin',0),
    (alice,'alice@x.com','alice',200000),
    (bob,'bob@x.com','bob',200000),
    (carol,'carol@x.com','carol',200000);

  money0 := pg_temp.money();

  ---------------------------------------------------------------- submit
  SELECT * INTO r FROM public.submit_open_market(
    creator, 'Will the CBN hold the MPR at its next meeting?', 'Monetary policy',
    'economy', ARRAY['Hold','Raise','Cut'], 'CBN website', 'First print counts',
    now() + interval '10 days', now() + interval '30 days');
  PERFORM pg_temp.check('submit accepted', r.applied, r.reason);
  mkt := r.market_id;

  PERFORM pg_temp.check('submitted market is invisible',
    (SELECT status FROM public.open_markets WHERE id=mkt) = 'pending_review');

  -- Trading must be impossible before approval, or the gate is decorative.
  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, alice, 0, 100, 1e9);
    PERFORM pg_temp.check('trade blocked before approval', false, 'trade succeeded!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('trade blocked before approval', true, SQLERRM);
  END;

  ---------------------------------------------------------------- approve
  SELECT * INTO r FROM public.review_open_market(
    mkt, admin, 'approve', 12::smallint,
    '{"resolution_clarity":2,"source_quality":2,"horizon_realism":2,
      "ambiguity_resistance":2,"audience_interest":2,"category_fit":2}'::jsonb,
    NULL, 'Clear and well sourced', 'starter',
    now() + interval '10 days', now() + interval '3 days');
  PERFORM pg_temp.check('approved', r.applied, r.reason);
  PERFORM pg_temp.check('b set from tier', r.b_tngn = 10000, 'b=' || r.b_tngn);
  PERFORM pg_temp.check('threshold = worst case = b*ln(N)',
    round(r.threshold_tngn,2) = round(10000*ln(3::numeric),2),
    'thr=' || round(r.threshold_tngn,2));

  -- Opening prices must be uniform on an untouched book, or the first trader
  -- gets a free edge from an outcome that was cheap before anyone bet.
  PERFORM pg_temp.check('opening prices uniform',
    (SELECT bool_and(round(p,6) = round(1.0/3,6))
       FROM unnest((SELECT public.lmsr_prices(q,b) FROM public.open_markets WHERE id=mkt)) p));

  ---------------------------------------------------------------- quote
  SELECT * INTO qt FROM public.quote_open_trade(mkt, 0, 1000);
  PERFORM pg_temp.check('quote priced', qt.total_tngn > 0,
    'cost ' || round(qt.cost_tngn,2) || ' fee ' || round(qt.fee_tngn,2));
  PERFORM pg_temp.check('fee is 1.5% of cost',
    round(qt.fee_tngn,2) = round(qt.cost_tngn*0.015,2));

  ---------------------------------------------------------------- buy
  SELECT tngn_balance INTO bal FROM public.users WHERE id=alice;
  SELECT * INTO t FROM public.execute_open_trade(
    'aaaaaaaa-0000-0000-0000-000000000001', mkt, alice, 0, 1000, 1e9);
  PERFORM pg_temp.check('buy executed', t.outcome='executed',
    'paid ' || round(t.total_tngn,2));
  spent := t.total_tngn;

  PERFORM pg_temp.check('wallet debited by exactly the quoted total',
    (SELECT tngn_balance FROM public.users WHERE id=alice) = bal - spent);
  PERFORM pg_temp.check('quote matched execution',
    round(qt.total_tngn,2) = round(spent,2),
    'quote ' || round(qt.total_tngn,2) || ' vs paid ' || round(spent,2));
  PERFORM pg_temp.check('price rose after buying',
    t.price_after > 1.0/3, 'price ' || round(t.price_after,4));

  -- Replaying the same client_trade_id must not charge twice. This is the
  -- single most important guard in the whole engine: a retry on a flaky phone
  -- connection is the normal case, not the exotic one.
  SELECT * INTO t FROM public.execute_open_trade(
    'aaaaaaaa-0000-0000-0000-000000000001', mkt, alice, 0, 1000, 1e9);
  PERFORM pg_temp.check('replay is idempotent', t.outcome='already_executed');
  PERFORM pg_temp.check('replay did not double-charge',
    (SELECT tngn_balance FROM public.users WHERE id=alice) = bal - spent);

  -- Same idempotency key with DIFFERENT parameters must be refused outright,
  -- not silently treated as the original trade.
  BEGIN
    PERFORM public.execute_open_trade(
      'aaaaaaaa-0000-0000-0000-000000000001', mkt, alice, 1, 5000, 1e9);
    PERFORM pg_temp.check('replay with different params refused', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('replay with different params refused', true, SQLERRM);
  END;

  ---------------------------------------------------------------- guards
  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, creator, 0, 1000, 1e9);
    PERFORM pg_temp.check('creator cannot trade own market', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('creator cannot trade own market', true, SQLERRM);
  END;

  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, bob, 0, 1000, 1);
    PERFORM pg_temp.check('slippage limit enforced on buy', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('slippage limit enforced on buy', true, SQLERRM);
  END;

  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, bob, 0, -500, 0);
    PERFORM pg_temp.check('naked short blocked', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('naked short blocked', true, SQLERRM);
  END;

  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, bob, 0, 1e9, 1e18);
    PERFORM pg_temp.check('position cap blocks cornering', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('position cap blocks cornering', true, SQLERRM);
  END;

  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt, bob, 0, 0.0001, 1e9);
    PERFORM pg_temp.check('dust trade blocked', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('dust trade blocked', true, SQLERRM);
  END;

  ---------------------------------------------------------------- round trip
  -- Buy then immediately sell the same size must LOSE money (the fee twice
  -- plus the spread). If it were ever profitable, wash trading would be free
  -- money and the creator threshold would be farmable.
  SELECT tngn_balance INTO bal FROM public.users WHERE id=bob;
  PERFORM public.execute_open_trade(
    'bbbbbbbb-0000-0000-0000-000000000001', mkt, bob, 1, 1000, 1e9);
  PERFORM public.execute_open_trade(
    'bbbbbbbb-0000-0000-0000-000000000002', mkt, bob, 1, -1000, -1e9);
  PERFORM pg_temp.check('round trip loses money',
    (SELECT tngn_balance FROM public.users WHERE id=bob) < bal,
    'net ' || round((SELECT tngn_balance FROM public.users WHERE id=bob) - bal, 2));

  -- Selling out completely must leave a position that is genuinely finished,
  -- not an 'open' row holding zero shares — that row is what the portfolio
  -- screen would otherwise render as a live holding forever.
  PERFORM pg_temp.check('fully-sold position holds no shares',
    (SELECT shares_cash + shares_bonus FROM public.open_positions
      WHERE market_id=mkt AND user_id=bob AND outcome_idx=1) = 0,
    'status=' || (SELECT status FROM public.open_positions
                   WHERE market_id=mkt AND user_id=bob AND outcome_idx=1));

  -- Carol buys the outcome that will win and holds it all the way through the
  -- horizon to resolution. Without her, settlement has nothing to pay and the
  -- payout half of this test is vacuous.
  PERFORM public.execute_open_trade(
    'cccccccc-0000-0000-0000-000000000001', mkt, carol, 1, 2000, 1e9);
  PERFORM pg_temp.check('holder took a position',
    (SELECT shares_cash FROM public.open_positions
      WHERE market_id=mkt AND user_id=carol AND outcome_idx=1) = 2000);

  ---------------------------------------------------------------- invariants
  PERFORM pg_temp.check('book invariants hold after trading',
    public.open_market_book_ok(mkt),
    (SELECT COALESCE(string_agg(check_name, ', '), 'none')
       FROM public.verify_open_market_book(mkt) WHERE NOT ok));

  PERFORM pg_temp.check('money conserved through trading',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));

  ---------------------------------------------------------------- fees
  PERFORM pg_temp.check('fees recorded',
    (SELECT fees_collected FROM public.open_markets WHERE id=mkt) > 0,
    'fees ' || round((SELECT fees_collected FROM public.open_markets WHERE id=mkt),2));
  PERFORM pg_temp.check('creator earns nothing below threshold',
    (SELECT creator_accrued FROM public.open_markets WHERE id=mkt) = 0);

  SELECT * INTO r FROM public.sweep_open_market_fees();
  PERFORM pg_temp.check('fee sweep moved fees to reserve', r.tngn_swept > 0,
    round(r.tngn_swept,2) || ' swept');
  PERFORM pg_temp.check('money conserved through sweep',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));
  PERFORM pg_temp.check('sweep is idempotent',
    (SELECT tngn_swept FROM public.sweep_open_market_fees()) = 0);

  ---------------------------------------------------------------- horizon
  SELECT * INTO r FROM public.open_horizon_window(mkt, 0::smallint, 72);
  PERFORM pg_temp.check('horizon window opened', r.applied, r.reason);

  SELECT id INTO mkt FROM public.open_markets WHERE id=mkt;   -- noop, keeps mkt
  -- Alice elects to cash out; Bob does nothing and should simply stay in.
  SELECT * INTO r FROM public.record_horizon_election(
    mkt, alice, (SELECT id FROM public.open_positions
                  WHERE market_id=mkt AND user_id=alice AND status='open' LIMIT 1), 'cash_out');
  PERFORM pg_temp.check('cash-out election recorded', r.applied, r.reason);

  -- A stranger must not be able to elect on someone else's position.
  SELECT * INTO r FROM public.record_horizon_election(
    mkt, bob, (SELECT id FROM public.open_positions
                WHERE market_id=mkt AND user_id=alice AND status='open' LIMIT 1), 'cash_out');
  PERFORM pg_temp.check('cannot elect on another user position', NOT r.applied, r.reason);

  SELECT tngn_balance INTO bal FROM public.users WHERE id=alice;
  -- Fast-forward past the 72h election window. close_horizon_window refuses
  -- while it is still open, which is correct: a window that can be closed
  -- early is a window a holder can be shut out of.
  UPDATE public.open_markets SET horizon_window_closes_at = now() - interval '1 minute'
   WHERE id = mkt;
  SELECT * INTO r FROM public.close_horizon_window(mkt, now() + interval '30 days', false);
  PERFORM pg_temp.check('horizon window closed', r.applied, r.reason);
  PERFORM pg_temp.check('leaver was paid',
    (SELECT tngn_balance FROM public.users WHERE id=alice) > bal,
    'paid ' || round((SELECT tngn_balance FROM public.users WHERE id=alice) - bal, 2));
  PERFORM pg_temp.check('stayer keeps an open position',
    EXISTS (SELECT 1 FROM public.open_positions
             WHERE market_id=mkt AND user_id=bob AND status='open'));
  PERFORM pg_temp.check('money conserved through horizon',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));
  PERFORM pg_temp.check('invariants hold after horizon',
    public.open_market_book_ok(mkt),
    (SELECT COALESCE(string_agg(check_name, ', '), 'none')
       FROM public.verify_open_market_book(mkt) WHERE NOT ok));

  ---------------------------------------------------------------- settle
  UPDATE public.open_markets SET status='closed', trading_closes_at=now()-interval '1 minute'
   WHERE id=mkt;

  -- Four eyes: the same person cannot both resolve and confirm.
  SELECT * INTO r FROM public.settle_open_market(mkt, 1, admin, admin, 'http://cbn', true);
  PERFORM pg_temp.check('settlement refuses one pair of eyes', NOT r.applied, r.reason);

  SELECT * INTO r FROM public.settle_open_market(mkt, 1, admin, creator, 'http://cbn', true);
  PERFORM pg_temp.check('settlement refuses the creator as confirmer', NOT r.applied, r.reason);

  INSERT INTO public.users(id,email,username) VALUES
    ('55555555-5555-5555-5555-555555555555','a2@x.com','admin2');

  -- A dry run deliberately reports applied=false: it is a preview, and
  -- returning true would make "did this actually settle?" ambiguous at the
  -- call site.
  SELECT * INTO r FROM public.settle_open_market(
    mkt, 1, admin, '55555555-5555-5555-5555-555555555555', 'http://cbn', true);
  PERFORM pg_temp.check('dry run reports as a preview',
    NOT r.applied AND r.reason = 'dry_run', r.reason);
  PERFORM pg_temp.check('dry run moved no money',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));

  SELECT * INTO r FROM public.settle_open_market(
    mkt, 1, admin, '55555555-5555-5555-5555-555555555555', 'http://cbn', false);
  PERFORM pg_temp.check('settlement computed', r.applied,
    r.positions || ' positions, ' || r.winners || ' winners, house pnl '
      || round(r.house_pnl,2));
  PERFORM pg_temp.check('settlement found the holder', r.winners >= 1,
    r.winners || ' winners');

  -- Payouts must NOT be released before the dispute window closes: clawing
  -- money back out of a spent wallet is only partially possible. This RAISES
  -- rather than returning a count, so any caller must treat it as an
  -- exception, not a zero.
  BEGIN
    PERFORM public.release_open_settlements(mkt, 250, false);
    PERFORM pg_temp.check('release blocked inside dispute window', false, 'released!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('release blocked inside dispute window', true, SQLERRM);
  END;

  UPDATE public.open_markets SET settlement_locked_until = now() - interval '1 minute'
   WHERE id = mkt;
  SELECT * INTO r FROM public.release_open_settlements(mkt, 250, false);
  PERFORM pg_temp.check('release paid out after the window', r.finished,
    r.released || ' released, ' || r.failed || ' failed');

  -- Once every row is released the market leaves pending_payout, so a rerun
  -- RAISES rather than quietly returning zero. A sweep cron must therefore
  -- treat a per-market failure as skip-and-continue, not abort-the-batch.
  BEGIN
    PERFORM public.release_open_settlements(mkt, 250, false);
    PERFORM pg_temp.check('rerun after finish is refused', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('rerun after finish is refused', true, SQLERRM);
  END;

  PERFORM pg_temp.check('winner was actually paid',
    (SELECT tngn_balance FROM public.users WHERE id=carol) > 0
    AND (SELECT released_at FROM public.open_settlements
          WHERE market_id=mkt AND kind='resolve' LIMIT 1) IS NOT NULL,
    'carol ' || round((SELECT tngn_balance FROM public.users WHERE id=carol),2));

  PERFORM pg_temp.check('money conserved through settlement',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));

  PERFORM pg_temp.check('final invariants hold',
    public.open_market_book_ok(mkt),
    (SELECT COALESCE(string_agg(check_name, ', '), 'none')
       FROM public.verify_open_market_book(mkt) WHERE NOT ok));

  PERFORM pg_temp.check('no negative balances anywhere',
    NOT EXISTS (SELECT 1 FROM public.users
                 WHERE tngn_balance < 0 OR bonus_balance < 0));

  RAISE NOTICE '--- house pnl over the whole life: % ---',
    round((SELECT total_tngn FROM public.house_reserve WHERE id=1) - 2000000, 2);
END
$e2e$;
