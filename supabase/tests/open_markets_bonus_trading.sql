-- Bonus-funded Open Markets trading (20260911000000_open_markets_bonus_trading).
--
-- The one rule everything here is checking: a bonus-funded share is NEVER
-- converted to cash, by anything. Buys may draw on bonus_balance; sells may
-- only ever draw down the cash lot; and every forced-exit path (resolve,
-- void, horizon cash-out) must pay a bonus-funded share back into bonus,
-- never into tngn. Also checks the accounting fix this unlocks: only
-- cash-funded fee revenue may count toward the creator payout threshold or
-- reach the real house reserve.
\set ON_ERROR_STOP on
\timing off
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 66), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 66), detail;
  END IF;
END$$;

-- Same whole-system invariant open_markets_e2e.sql uses: wallets + reserve +
-- money in flight inside a live LMSR book, minus what has already left that
-- book as a released settlement or a swept fee.
CREATE OR REPLACE FUNCTION pg_temp.money() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT (SELECT COALESCE(SUM(tngn_balance + bonus_balance),0) FROM public.users)
       + (SELECT COALESCE(total_tngn,0) FROM public.house_reserve WHERE id=1)
       + (SELECT COALESCE(SUM(paid_cash + paid_bonus),0) FROM public.open_trades)
       - (SELECT COALESCE(SUM(tngn + bonus),0) FROM public.open_settlements
           WHERE released_at IS NOT NULL)
       - (SELECT COALESCE(SUM(fees_swept),0) FROM public.open_markets)
$$;

DO $bt$
DECLARE
  creator uuid := '11111111-1111-1111-1111-111111111111';
  admin   uuid := '22222222-2222-2222-2222-222222222222';
  admin2  uuid := '55555555-5555-5555-5555-555555555555';
  dave    uuid := '77777777-7777-7777-7777-777777777777';   -- bonus-only trader
  erin    uuid := '88888888-8888-8888-8888-888888888888';   -- mixed cash+bonus trader
  frank   uuid := '99999999-9999-9999-9999-999999999999';   -- cash-only control
  grace   uuid := 'aaaaaaa1-1111-1111-1111-111111111111';   -- void: bonus-only holder
  heidi   uuid := 'aaaaaaa2-2222-2222-2222-222222222222';   -- void: cash-only holder
  ivan    uuid := 'aaaaaaa3-3333-3333-3333-333333333333';   -- horizon: bonus-only holder

  mkt_a uuid;  -- trade / sell-guard / fee-real / creator / sweep / settle
  mkt_b uuid;  -- void pro_rata split
  mkt_c uuid;  -- horizon cash_out split

  money0 numeric;
  r record; qt record; t record; pos record;
  bal_bonus numeric; bal_cash numeric;
  cash_frac numeric;
  sell_ok numeric; sell_too_much numeric;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance) VALUES
    (creator,'c@x.com','creator',0,0),
    (admin,'a@x.com','admin',0,0),
    (admin2,'a2@x.com','admin2',0,0),
    (dave,'dave@x.com','dave',0,1000000),
    (erin,'erin@x.com','erin',500,1000000),
    (frank,'frank@x.com','frank',1000000,0),
    (grace,'grace@x.com','grace',0,50000),
    (heidi,'heidi@x.com','heidi',50000,0),
    (ivan,'ivan@x.com','ivan',0,50000);

  money0 := pg_temp.money();

  -- ══════════════ Market A: buy/sell guard, fee-real, creator, sweep, settle ══
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => creator, p_question => 'Will bonus-funded trading ship without a laundering hole?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '10 days', p_submitted_by => NULL);
  PERFORM pg_temp.check('market A submitted', r.applied, r.reason);
  mkt_a := r.market_id;

  SELECT * INTO r FROM public.review_open_market(
    mkt_a, admin, 'approve', 12::smallint,
    '{"resolution_clarity":2,"source_quality":2,"horizon_realism":2,
      "ambiguity_resistance":2,"audience_interest":2,"category_fit":2}'::jsonb,
    NULL, 'Clear', 'starter', now() + interval '30 days', now() + interval '10 days');
  PERFORM pg_temp.check('market A approved', r.applied, r.reason);

  -- Isolate the fee/creator-threshold accounting from LMSR's own cost curve:
  -- a realistic b*ln(N) threshold needs huge volume to cross, which this test
  -- doesn't care about — it cares whether BONUS-funded volume can cross it.
  UPDATE public.open_markets SET threshold_tngn = 1 WHERE id = mkt_a;

  ---------------- dave: buy funded ENTIRELY by bonus ----------------
  bal_bonus := (SELECT bonus_balance FROM public.users WHERE id=dave);
  SELECT * INTO t FROM public.execute_open_trade(
    'd0000000-0000-0000-0000-000000000001', mkt_a, dave, 0, 3000, 1e9);
  PERFORM pg_temp.check('bonus-only buy executed', t.outcome='executed',
    'paid ' || round(t.total_tngn,2));

  PERFORM pg_temp.check('bonus-only buy debits bonus_balance, never tngn_balance',
    (SELECT tngn_balance FROM public.users WHERE id=dave) = 0
    AND round((SELECT bonus_balance FROM public.users WHERE id=dave),2) = round(bal_bonus - t.total_tngn,2),
    'tngn=' || (SELECT tngn_balance FROM public.users WHERE id=dave)
      || ' bonus=' || round((SELECT bonus_balance FROM public.users WHERE id=dave),2));

  SELECT * INTO pos FROM public.open_positions
   WHERE market_id=mkt_a AND user_id=dave AND outcome_idx=0;
  PERFORM pg_temp.check('bonus-only buy lands entirely in the bonus lot',
    pos.shares_cash = 0 AND pos.shares_bonus = 3000
    AND pos.cost_cash = 0 AND round(pos.cost_bonus,2) = round(t.total_tngn,2),
    'shares_cash=' || pos.shares_cash || ' shares_bonus=' || pos.shares_bonus);

  -- The exact guard this migration exists to keep: a bonus lot must never
  -- sell back for cash, full stop — not even when the whole position is bonus.
  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt_a, dave, 0, -500, -1e9);
    PERFORM pg_temp.check('bonus lot refuses to sell', false, 'sell accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('bonus lot refuses to sell', true, SQLERRM);
  END;

  PERFORM pg_temp.check('gross fees crossed the (lowered) threshold',
    (SELECT fees_collected FROM public.open_markets WHERE id=mkt_a) > 1,
    'fees_collected=' || round((SELECT fees_collected FROM public.open_markets WHERE id=mkt_a),2));
  PERFORM pg_temp.check('creator earns NOTHING on bonus-funded volume — the loophole this closes',
    (SELECT creator_accrued FROM public.open_markets WHERE id=mkt_a) = 0
    AND (SELECT fees_collected_real FROM public.open_markets WHERE id=mkt_a) = 0,
    'creator_accrued=' || (SELECT creator_accrued FROM public.open_markets WHERE id=mkt_a)
      || ' fees_real=' || (SELECT fees_collected_real FROM public.open_markets WHERE id=mkt_a));

  SELECT * INTO r FROM public.sweep_open_market_fees();
  PERFORM pg_temp.check('sweep moves nothing while fees are 100% bonus-funded',
    r.tngn_swept = 0, 'swept ' || round(r.tngn_swept,2));

  ---------------- frank: cash-only control (byte-identical to v1) ----------------
  bal_cash := (SELECT tngn_balance FROM public.users WHERE id=frank);
  SELECT * INTO t FROM public.execute_open_trade(
    'f0000000-0000-0000-0000-000000000001', mkt_a, frank, 1, 1000, 1e9);
  PERFORM pg_temp.check('cash-only buy executed', t.outcome='executed', 'paid ' || round(t.total_tngn,2));
  PERFORM pg_temp.check('cash-only buy touches only tngn_balance',
    (SELECT tngn_balance FROM public.users WHERE id=frank) = bal_cash - t.total_tngn
    AND (SELECT bonus_balance FROM public.users WHERE id=frank) = 0);

  SELECT * INTO pos FROM public.open_positions WHERE market_id=mkt_a AND user_id=frank AND outcome_idx=1;
  PERFORM pg_temp.check('cash-only position carries no bonus lot',
    pos.shares_bonus = 0 AND pos.cost_bonus = 0);

  PERFORM pg_temp.check('creator now earns something — real (cash) fees crossed the threshold',
    (SELECT creator_accrued FROM public.open_markets WHERE id=mkt_a) > 0,
    'creator_accrued=' || round((SELECT creator_accrued FROM public.open_markets WHERE id=mkt_a),4));
  PERFORM pg_temp.check('creator accrual matches 25% of REAL fees above threshold, not gross',
    round((SELECT creator_accrued FROM public.open_markets WHERE id=mkt_a),2)
      = round(0.25 * GREATEST((SELECT fees_collected_real FROM public.open_markets WHERE id=mkt_a) - 1, 0), 2));

  SELECT * INTO r FROM public.sweep_open_market_fees();
  PERFORM pg_temp.check('sweep now moves exactly the real (cash) fee, none of the bonus fee',
    round(r.tngn_swept,2) = round((SELECT fees_collected_real FROM public.open_markets WHERE id=mkt_a),2),
    'swept ' || round(r.tngn_swept,2));
  PERFORM pg_temp.check('gross fees remain strictly above what was swept — the bonus fee was excluded',
    (SELECT fees_collected FROM public.open_markets WHERE id=mkt_a)
      > (SELECT fees_swept FROM public.open_markets WHERE id=mkt_a));

  ---------------- erin: mixed cash+bonus buy, then a bounded sell ----------------
  SELECT * INTO qt FROM public.quote_open_trade(mkt_a, 1, 2000);
  PERFORM pg_temp.check('erin''s buy would cost more than her ₦500 cash (exercises the split)',
    qt.total_tngn > 500, 'quoted total ' || round(qt.total_tngn,2));

  bal_cash  := (SELECT tngn_balance FROM public.users WHERE id=erin);
  bal_bonus := (SELECT bonus_balance FROM public.users WHERE id=erin);
  SELECT * INTO t FROM public.execute_open_trade(
    'e0000000-0000-0000-0000-000000000001', mkt_a, erin, 1, 2000, 1e9);
  PERFORM pg_temp.check('mixed buy executed', t.outcome='executed', 'paid ' || round(t.total_tngn,2));

  PERFORM pg_temp.check('mixed buy drains cash to zero first, bonus for the remainder',
    (SELECT tngn_balance FROM public.users WHERE id=erin) = 0
    AND round((SELECT bonus_balance FROM public.users WHERE id=erin),2)
        = round(bal_bonus - (t.total_tngn - bal_cash), 2),
    'bonus=' || round((SELECT bonus_balance FROM public.users WHERE id=erin),2));

  SELECT * INTO pos FROM public.open_positions WHERE market_id=mkt_a AND user_id=erin AND outcome_idx=1;
  cash_frac := bal_cash / t.total_tngn;
  PERFORM pg_temp.check('mixed position splits shares in the same ratio as the money',
    abs(pos.shares_cash - 2000*cash_frac) < 0.01
    AND abs(pos.shares_bonus - (2000 - 2000*cash_frac)) < 0.01,
    'shares_cash=' || round(pos.shares_cash,2) || ' shares_bonus=' || round(pos.shares_bonus,2));
  PERFORM pg_temp.check('mixed position cost basis splits the same way',
    round(pos.cost_cash,2) = round(bal_cash,2) AND round(pos.cost_bonus,2) = round(t.total_tngn - bal_cash, 2));

  -- Selling within the cash lot must succeed EVEN THOUGH the position also
  -- holds bonus shares — this is exactly the blunt v1 guard this migration
  -- replaces (it refused the WHOLE position the moment any bonus lot existed
  -- on it at all, rather than just capping the sell at the cash lot).
  sell_ok := GREATEST(floor(pos.shares_cash / 2), 1);
  SELECT * INTO t FROM public.execute_open_trade(
    'e0000000-0000-0000-0000-000000000002', mkt_a, erin, 1, -sell_ok, -1e9);
  PERFORM pg_temp.check('selling within the cash lot succeeds despite holding bonus shares too',
    t.outcome = 'executed', 'sold ' || sell_ok);

  -- Selling past what remains in the cash lot must still be refused: the fix
  -- scopes unsellability to the bonus lot specifically, not "any bonus
  -- exists on this position" — but it must still refuse dipping INTO it.
  SELECT * INTO pos FROM public.open_positions WHERE market_id=mkt_a AND user_id=erin AND outcome_idx=1;
  sell_too_much := pos.shares_cash + 100;
  BEGIN
    PERFORM public.execute_open_trade(gen_random_uuid(), mkt_a, erin, 1, -sell_too_much, -1e9);
    PERFORM pg_temp.check('selling past the cash lot into the bonus lot is still refused', false, 'accepted!');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('selling past the cash lot into the bonus lot is still refused', true, SQLERRM);
  END;

  ---------------- settle: dave's bonus-funded position wins ----------------
  UPDATE public.open_markets SET status='closed', trading_closes_at = now() - interval '1 minute'
   WHERE id = mkt_a;

  SELECT * INTO r FROM public.settle_open_market(mkt_a, 0, admin, admin2, 'internal record', false);
  PERFORM pg_temp.check('market A settled — outcome 0 (dave''s bonus position) wins', r.applied, r.reason);

  UPDATE public.open_markets SET settlement_locked_until = now() - interval '1 minute' WHERE id = mkt_a;
  SELECT * INTO r FROM public.release_open_settlements(mkt_a, 250, false);
  PERFORM pg_temp.check('market A payouts released', r.finished, r.released || ' released, ' || r.failed || ' failed');

  PERFORM pg_temp.check('winning bonus-funded shares pay into bonus_balance, never cash',
    (SELECT tngn_balance FROM public.users WHERE id=dave) = 0
    AND (SELECT bonus_balance FROM public.users WHERE id=dave) > 0,
    'tngn=' || (SELECT tngn_balance FROM public.users WHERE id=dave)
      || ' bonus=' || round((SELECT bonus_balance FROM public.users WHERE id=dave),2));

  PERFORM pg_temp.check('erin''s losing outcome (1) settled to zero, nothing further paid',
    NOT EXISTS (SELECT 1 FROM public.open_settlements s
                 JOIN public.open_positions p ON p.id = s.position_id
                WHERE p.market_id = mkt_a AND p.user_id = erin AND s.kind='resolve'
                  AND (s.tngn > 0 OR s.bonus > 0)));

  PERFORM pg_temp.check('money conserved through market A''s whole lifecycle',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));

  PERFORM pg_temp.check('market A invariants hold, including the real-fee creator replay',
    public.open_market_book_ok(mkt_a),
    (SELECT COALESCE(string_agg(check_name, ', '), 'none')
       FROM public.verify_open_market_book(mkt_a) WHERE NOT ok));

  -- ══════════════ Market B: void pro_rata pays each currency to its source ═══
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => creator, p_question => 'Does a pro-rata void correctly split cash and bonus payouts?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '10 days', p_submitted_by => NULL);
  PERFORM pg_temp.check('market B submitted', r.applied, r.reason);
  mkt_b := r.market_id;

  SELECT * INTO r FROM public.review_open_market(
    mkt_b, admin, 'approve', 12::smallint,
    '{"resolution_clarity":2,"source_quality":2,"horizon_realism":2,
      "ambiguity_resistance":2,"audience_interest":2,"category_fit":2}'::jsonb,
    NULL, 'Clear', 'starter', now() + interval '30 days', now() + interval '10 days');
  PERFORM pg_temp.check('market B approved', r.applied, r.reason);

  -- grace (bonus-only) and heidi (cash-only) both take a position on the SAME
  -- outcome — fine, the complete-set guard only fires on one user holding
  -- multiple outcomes of the same market, not two users on the same one.
  SELECT * INTO t FROM public.execute_open_trade(
    'b0000000-0000-0000-0000-000000000001', mkt_b, grace, 0, 1000, 1e9);
  PERFORM pg_temp.check('grace (bonus-only) took a position in market B', t.outcome='executed');

  SELECT * INTO t FROM public.execute_open_trade(
    'b0000000-0000-0000-0000-000000000002', mkt_b, heidi, 0, 1000, 1e9);
  PERFORM pg_temp.check('heidi (cash-only) took a position in market B', t.outcome='executed');

  SELECT * INTO r FROM public.void_open_market(mkt_b, 'operational', 'pro_rata', admin, admin2, 'test void', false);
  PERFORM pg_temp.check('market B voided pro_rata', r.applied, r.reason);

  UPDATE public.open_markets SET settlement_locked_until = now() - interval '1 minute' WHERE id = mkt_b;
  SELECT * INTO r FROM public.release_open_settlements(mkt_b, 250, false);
  PERFORM pg_temp.check('market B void payouts released', r.finished, r.released || ' released');

  PERFORM pg_temp.check('void pro_rata pays a bonus-only holder entirely in bonus, never cash',
    (SELECT s.tngn FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_b AND p.user_id=grace AND s.kind='void') = 0
    AND (SELECT s.bonus FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_b AND p.user_id=grace AND s.kind='void') > 0,
    'tngn=' || (SELECT s.tngn FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_b AND p.user_id=grace AND s.kind='void')
      || ' bonus=' || round((SELECT s.bonus FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_b AND p.user_id=grace AND s.kind='void'),2));

  PERFORM pg_temp.check('void pro_rata pays a cash-only holder almost entirely in cash (residual kobo aside)',
    (SELECT s.tngn FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_b AND p.user_id=heidi AND s.kind='void') > 0
    AND (SELECT s.bonus FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_b AND p.user_id=heidi AND s.kind='void') < 0.02);

  PERFORM pg_temp.check('grace actually received her payout in bonus_balance',
    (SELECT bonus_balance FROM public.users WHERE id=grace) > 0);

  PERFORM pg_temp.check('money conserved through market B''s void',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));

  -- ══════════════ Market C: horizon cash_out pays each currency to its source ═
  SELECT * INTO r FROM public.submit_open_market(
    p_created_by => creator, p_question => 'Does a forced horizon cash-out correctly split cash and bonus?',
    p_description => NULL, p_category => 'economy',
    p_outcomes => ARRAY['Yes','No'], p_resolution_source => 'Internal record',
    p_trading_closes_at => now() + interval '10 days', p_submitted_by => NULL);
  PERFORM pg_temp.check('market C submitted', r.applied, r.reason);
  mkt_c := r.market_id;

  SELECT * INTO r FROM public.review_open_market(
    mkt_c, admin, 'approve', 12::smallint,
    '{"resolution_clarity":2,"source_quality":2,"horizon_realism":2,
      "ambiguity_resistance":2,"audience_interest":2,"category_fit":2}'::jsonb,
    NULL, 'Clear', 'starter', now() + interval '30 days', now() + interval '10 days');
  PERFORM pg_temp.check('market C approved', r.applied, r.reason);

  SELECT * INTO t FROM public.execute_open_trade(
    'c0000000-0000-0000-0000-000000000001', mkt_c, ivan, 0, 1000, 1e9);
  PERFORM pg_temp.check('ivan (bonus-only) took a position in market C', t.outcome='executed');

  SELECT * INTO r FROM public.open_horizon_window(mkt_c, 0::smallint, 72);
  PERFORM pg_temp.check('market C horizon window opened', r.applied, r.reason);

  SELECT * INTO r FROM public.record_horizon_election(
    mkt_c, ivan, (SELECT id FROM public.open_positions
                   WHERE market_id=mkt_c AND user_id=ivan AND status='open' LIMIT 1), 'cash_out');
  PERFORM pg_temp.check('ivan elected cash_out', r.applied, r.reason);

  UPDATE public.open_markets SET horizon_window_closes_at = now() - interval '1 minute' WHERE id = mkt_c;
  SELECT * INTO r FROM public.close_horizon_window(mkt_c, now() + interval '30 days', false);
  PERFORM pg_temp.check('market C horizon window closed', r.applied, r.reason);

  PERFORM pg_temp.check('forced cash-out pays a bonus-only holder entirely in bonus, never cash',
    (SELECT s.tngn FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_c AND p.user_id=ivan AND s.kind='cash_out') = 0
    AND (SELECT s.bonus FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_c AND p.user_id=ivan AND s.kind='cash_out') > 0,
    'bonus=' || round((SELECT s.bonus FROM public.open_settlements s JOIN public.open_positions p ON p.id=s.position_id
      WHERE p.market_id=mkt_c AND p.user_id=ivan AND s.kind='cash_out'),2));

  PERFORM pg_temp.check('ivan actually received the payout in bonus_balance',
    (SELECT bonus_balance FROM public.users WHERE id=ivan) > 0);

  PERFORM pg_temp.check('money conserved through market C''s horizon cash-out',
    round(pg_temp.money(),2) = round(money0,2),
    'delta ' || round(pg_temp.money() - money0, 2));

  PERFORM pg_temp.check('no negative balances anywhere at the end',
    NOT EXISTS (SELECT 1 FROM public.users WHERE tngn_balance < 0 OR bonus_balance < 0));
END
$bt$;
