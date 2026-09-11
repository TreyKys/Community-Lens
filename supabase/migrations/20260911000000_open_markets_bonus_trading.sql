-- Open Markets v2: bonus_balance becomes spendable.
--
-- v1 refused bonus outright because an LMSR round-trip is nearly free: buy
-- with bonus, sell straight back for cash, and the platform has laundered
-- promotional credit at ~98% efficiency with no prediction involved. The
-- schema was built anticipating this day (share LOTS on open_positions,
-- paid_bonus on open_trades, bonus on open_settlements, fees_collected_real
-- split from fees_collected) — this migration is the day.
--
-- The rule that makes it safe: BONUS LOTS ARE NEVER SELLABLE FOR CASH, in any
-- exit path. They can only go one of two ways — win, and settle back into
-- bonus_balance (never withdrawable cash); or lose/void/expire, and settle to
-- zero or back into bonus_balance. A bonus-funded share is never converted to
-- cash by anything this migration touches. Four payout paths move money off
-- an open_positions row, and all four needed checking:
--
--   1. execute_open_trade (sell)      — refuses to sell past shares_cash.
--   2. settle_open_market (resolve)   — already correct: pays shares_bonus
--      into the settlement's `bonus` column, shares_cash into `tngn`. Not
--      touched here.
--   3. void_open_market (pro_rata)    — was paying 100% into `tngn` regardless
--      of what funded the shares. Fixed below.
--   4. close_horizon_window (curve)   — same bug, same fix, below.
--
-- And two accounting paths needed the "only real fees count" rule the schema
-- comment already promised: creator_accrued must never be earned against
-- bonus-funded trading volume, and the reserve must never be topped up with a
-- fee that was never actually deposited as cash.

-- ============================================================================
-- 1. execute_open_trade — cash-first bonus funding on buys, cash-only sells
-- ============================================================================
CREATE OR REPLACE FUNCTION public.execute_open_trade(
  p_client_trade_id uuid,      -- idempotency anchor; caller generates it
  p_market_id       uuid,
  p_user_id         uuid,
  p_outcome_idx     integer,
  p_delta_shares    numeric,   -- + buy, − sell
  p_limit_tngn      numeric    -- buy: max total cost. sell: min proceeds.
)
RETURNS TABLE (
  outcome       text,          -- executed | already_executed
  cost_tngn     numeric,
  fee_tngn      numeric,
  total_tngn    numeric,       -- signed: + leaves wallet, − enters it
  shares_after  numeric,
  price_after   numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_fee_pct   constant numeric := 0.015;
  c_min_trade constant numeric := 100;     -- ₦100. Below this the fee rounds
                                           -- away, and LMSR is path-independent,
                                           -- so subdivision would avoid it entirely.
  c_creator_share constant numeric := 0.25;

  v_mkt      public.open_markets%ROWTYPE;
  v_prior    public.open_trades%ROWTYPE;
  v_pos      public.open_positions%ROWTYPE;
  v_held     numeric := 0;
  v_n        integer;
  v_idx      integer;
  v_next     numeric[];
  v_raw      numeric;
  v_cost     numeric;
  v_fee      numeric;
  v_fee_real numeric;
  v_total    numeric;
  v_cash     numeric;
  v_bonus    numeric;
  v_bonus_expires_at   timestamptz;
  v_cash_used          numeric;
  v_bonus_used         numeric;
  v_shares_cash_delta  numeric;
  v_shares_bonus_delta numeric;
  v_other    bigint;
  v_basis_sold  numeric := 0;
  v_accr_before numeric;
  v_accr_after  numeric;
BEGIN
  -- ── 1. Idempotency FIRST. A committed trade whose response was lost must
  -- replay, not re-execute. The row lock prevents interleaving; only this
  -- prevents repetition.
  SELECT * INTO v_prior FROM public.open_trades
   WHERE client_trade_id = p_client_trade_id;
  IF FOUND THEN
    -- The key alone is not enough. client_trade_id is a column on open_trades,
    -- so without this check a caller replaying someone else's key receives
    -- that trade's cost, fee, size and fill price — a confident "success" for
    -- a trade they never made, and a disclosure of another user's economics.
    IF v_prior.user_id      <> p_user_id
       OR v_prior.market_id   <> p_market_id
       OR v_prior.outcome_idx <> p_outcome_idx
       OR v_prior.delta_shares <> p_delta_shares THEN
      RAISE EXCEPTION 'client_trade_id % already used for a different trade',
        p_client_trade_id USING ERRCODE = 'P0001';
    END IF;
    -- Replay the RECORDED result. Re-reading the live position here would
    -- report a figure another trade has since moved, so a retrying client
    -- would see a number that never corresponded to its own trade.
    RETURN QUERY SELECT 'already_executed'::text, v_prior.cost_tngn, v_prior.fee_tngn,
                        v_prior.cost_tngn + v_prior.fee_tngn,
                        v_prior.shares_after, v_prior.price_after;
    RETURN;
  END IF;

  -- ── 2. Lock the market. This serialises every trader on this book.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market not found' USING ERRCODE = 'P0002';
  END IF;

  -- Engine-wide kill switch. A per-market halt is not enough when the fault is
  -- in the pricing function itself.
  -- COALESCE is load-bearing: if the singleton row is missing, the subquery is
  -- NULL, NOT NULL is NULL, and plpgsql takes NEITHER branch — the kill switch
  -- silently fails OPEN, which is the one behaviour it must never have.
  IF NOT COALESCE((SELECT trading_enabled FROM public.open_markets_config WHERE id = 1), false) THEN
    RAISE EXCEPTION 'open markets trading is disabled' USING ERRCODE = 'P0001';
  END IF;

  IF v_mkt.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open (status=%)', v_mkt.status USING ERRCODE = 'P0001';
  END IF;
  IF v_mkt.trading_closes_at IS NOT NULL AND now() >= v_mkt.trading_closes_at THEN
    RAISE EXCEPTION 'trading closed' USING ERRCODE = 'P0001';
  END IF;
  -- Freeze by the CLOCK, not by when the horizon cron happens to fire.
  -- horizon_at is on a publicly readable table, so any lag between the
  -- published time and the job flipping the status is a window in which
  -- everyone knows an unwind is coming and can still exit at full price.
  IF v_mkt.horizon_at IS NOT NULL AND now() >= v_mkt.horizon_at THEN
    RAISE EXCEPTION 'horizon reached; trading frozen pending review' USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. Creators may never trade their own market.
  -- They write the question, so they hold the best prior on the platform, AND
  -- they have the audience the growth model depends on. Buying one side while
  -- promoting the other is a ~54% return funded entirely by their own
  -- followers — and it shows up on a house-P&L dashboard as a PROFITABLE
  -- market, so it is invisible unless it is simply prevented. Their
  -- compensation is the fee share; that is the point of it.
  IF v_mkt.created_by IS NOT NULL AND v_mkt.created_by = p_user_id THEN
    RAISE EXCEPTION 'creators cannot trade their own market' USING ERRCODE = 'P0001';
  END IF;

  -- And the admin who submitted it, house market or not. On a house market
  -- created_by is NULL, so without this an admin could submit a market, get
  -- it approved, trade it, and then resolve it — the whole loop, with the
  -- outcome in their gift. That is insider trading, and it leaves no trace
  -- unless it is simply refused here.
  IF v_mkt.submitted_by IS NOT NULL AND v_mkt.submitted_by = p_user_id THEN
    RAISE EXCEPTION 'whoever submitted this market cannot trade it' USING ERRCODE = 'P0001';
  END IF;

  v_n := array_length(v_mkt.outcomes, 1);
  -- array_length of an empty array is NULL, and every guard below compares
  -- against it. A NULL there is not "unknown", it is "no check ran": the
  -- range check, complete-set check, minimum-trade check, both slippage
  -- guards and the BALANCE check all evaluate to NULL and fall through.
  IF v_n IS NULL OR v_n < 2 THEN
    RAISE EXCEPTION 'market has no valid outcomes' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome_idx < 0 OR p_outcome_idx >= v_n THEN
    RAISE EXCEPTION 'outcome index out of range' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares IS NULL OR p_delta_shares = 0 THEN
    RAISE EXCEPTION 'delta_shares must be non-zero' USING ERRCODE = 'P0001';
  END IF;
  v_idx := p_outcome_idx + 1;   -- postgres arrays are 1-based

  -- ── 4. Existing position.
  SELECT * INTO v_pos FROM public.open_positions
   WHERE market_id = p_market_id AND user_id = p_user_id AND outcome_idx = p_outcome_idx
   FOR UPDATE;
  IF FOUND THEN v_held := v_pos.shares_cash + v_pos.shares_bonus; END IF;

  -- ── 5. No naked shorts, AND bonus lots are never sellable. Selling shares
  -- you don't hold is borrowing from the house: proceeds asymptote to
  -- b·ln(N) while the liability grows linearly, so the house's loss is
  -- unbounded rather than capped. Selling a BONUS lot is a different problem
  -- entirely: it is the laundering path this whole feature exists to close,
  -- so it is refused categorically, not just capped — a sell may only ever
  -- draw down shares_cash.
  IF p_delta_shares < 0 AND COALESCE(v_pos.shares_cash, 0) + p_delta_shares < 0 THEN
    RAISE EXCEPTION 'cannot sell more than your cash-funded shares (bonus lots are not sellable)'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 6. No complete sets. Holding every outcome is a risk-free instrument
  -- (cost == payout exactly). Harmless with one currency; with two it is a
  -- laundering path, and it is a pure drain on fees regardless.
  IF p_delta_shares > 0 AND v_n > 1 THEN
    SELECT count(*) INTO v_other FROM public.open_positions
     WHERE market_id = p_market_id AND user_id = p_user_id
       AND outcome_idx <> p_outcome_idx AND (shares_cash + shares_bonus) > 0;
    IF v_other >= v_n - 1 THEN
      RAISE EXCEPTION 'this trade would complete a set' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 6b. Per-account position cap. One account cornering the book realises
  -- the house's whole subsidy without any second opinion ever being expressed,
  -- which is both an exposure event and a worthless market.
  IF p_delta_shares > 0
     AND (v_held + p_delta_shares) > v_mkt.max_position_mult * v_mkt.b THEN
    RAISE EXCEPTION 'position cap: max % shares of one outcome',
      v_mkt.max_position_mult * v_mkt.b USING ERRCODE = 'P0001';
  END IF;

  -- ── 7. Price from the LOCKED book.
  v_next := v_mkt.q;
  v_next[v_idx] := v_next[v_idx] + p_delta_shares;
  v_raw  := public.lmsr_cost(v_next, v_mkt.b) - public.lmsr_cost(v_mkt.q, v_mkt.b);

  -- ceil() is house-favourable in BOTH directions: on a buy it raises what the
  -- user pays; on a sell the cost is negative, so ceil moves it toward zero and
  -- shrinks what the user receives. Flooring a sell would hand out a fraction
  -- of a kobo on every single exit.
  v_cost := ceil(v_raw * 100) / 100;

  -- The minimum blocks ENTRIES, not exits: a residual position worth ₦80 must
  -- still be closable or the user's money is trapped by a guard meant to
  -- protect fee revenue.
  IF abs(v_cost) < c_min_trade
     AND NOT (p_delta_shares < 0 AND v_pos.shares_cash + p_delta_shares = 0) THEN
    RAISE EXCEPTION 'trade below minimum of %', c_min_trade USING ERRCODE = 'P0001';
  END IF;

  v_fee   := GREATEST(ceil(abs(v_cost) * c_fee_pct * 100) / 100, 0.01);
  v_total := v_cost + v_fee;

  -- ── 8. Slippage guard, compared against what actually leaves the wallet.
  -- Comparing against the pre-fee cost would make every user's guard 1.5%
  -- looser than they believe. Mandatory in BOTH directions — a sell needs a
  -- floor on proceeds exactly as a buy needs a ceiling on cost.
  IF p_limit_tngn IS NULL THEN
    RAISE EXCEPTION 'p_limit_tngn is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares > 0 AND v_total > p_limit_tngn THEN
    RAISE EXCEPTION 'slippage: cost % exceeds limit %', v_total, p_limit_tngn
      USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares < 0 AND (-v_total) < p_limit_tngn THEN
    RAISE EXCEPTION 'slippage: proceeds % below limit %', -v_total, p_limit_tngn
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 9. Wallet, under the user row lock. Debiting via credit_user would be
  -- wrong: it CLAMPS at zero, so an over-debit succeeds silently and the
  -- shortfall disappears instead of raising.
  SELECT tngn_balance, bonus_balance, bonus_expires_at
    INTO v_cash, v_bonus, v_bonus_expires_at
  FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;
  v_cash  := COALESCE(v_cash, 0);
  v_bonus := COALESCE(v_bonus, 0);

  -- Expire stale bonus in-transaction before computing available balance —
  -- the same rule place_bet_locked already applies, so a balance that only
  -- LOOKS spendable on screen cannot fund a trade after its 7 days are up.
  IF v_bonus > 0 AND v_bonus_expires_at IS NOT NULL AND v_bonus_expires_at <= now() THEN
    v_bonus := 0;
    UPDATE public.users SET bonus_balance = 0, bonus_expires_at = NULL WHERE id = p_user_id;
  END IF;

  IF p_delta_shares > 0 THEN
    -- Cash first, bonus for the remainder — the same rule place_bet and
    -- place_bet_locked already use, so a user's liquid cash funds the
    -- position before its unsellable bonus portion does.
    IF v_cash + v_bonus < v_total THEN
      RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
    END IF;
    IF v_cash >= v_total THEN
      v_cash_used  := v_total;
      v_bonus_used := 0;
    ELSE
      v_cash_used  := v_cash;
      v_bonus_used := v_total - v_cash;
    END IF;
    UPDATE public.users
       SET tngn_balance  = tngn_balance  - v_cash_used,
           bonus_balance = bonus_balance - v_bonus_used
     WHERE id = p_user_id;
  ELSE
    -- Sells are cash-only — step 5 already refused a sell that would dip into
    -- a bonus lot — so every naira of proceeds is cash, same as v1.
    v_cash_used  := v_total;
    v_bonus_used := 0;
    UPDATE public.users SET tngn_balance = tngn_balance + (-v_total) WHERE id = p_user_id;
  END IF;

  -- ── 10. Position lots. A buy splits shares AND cost proportionally to how
  -- it was funded, so shares_bonus/cost_bonus always carries exactly the
  -- lot that must never be sold for cash. A sell only ever touches the cash
  -- lot (step 5 guarantees v_pos already exists and holds enough shares_cash).
  IF p_delta_shares > 0 THEN
    v_shares_cash_delta  := p_delta_shares * (v_cash_used / v_total);
    v_shares_bonus_delta := p_delta_shares - v_shares_cash_delta;
  END IF;

  IF v_pos.id IS NULL THEN
    INSERT INTO public.open_positions (market_id, user_id, outcome_idx,
                                        shares_cash, shares_bonus, cost_cash, cost_bonus)
    VALUES (p_market_id, p_user_id, p_outcome_idx,
            v_shares_cash_delta, v_shares_bonus_delta, v_cash_used, v_bonus_used)
    RETURNING * INTO v_pos;
  ELSIF p_delta_shares > 0 THEN
    UPDATE public.open_positions
       SET shares_cash  = shares_cash  + v_shares_cash_delta,
           shares_bonus = shares_bonus + v_shares_bonus_delta,
           cost_cash    = cost_cash    + v_cash_used,
           cost_bonus   = cost_bonus   + v_bonus_used
     WHERE id = v_pos.id
     RETURNING * INTO v_pos;
  ELSE
    -- Selling retires basis PROPORTIONALLY. Subtracting the proceeds instead
    -- would leave the remaining shares carrying the wrong basis, and would push
    -- cost_cash negative on any profitable exit — making every P&L figure
    -- derived from it wrong.
    -- Denominator is the CASH lot, matching the lot being sold — the only lot
    -- a sell is ever allowed to touch.
    v_basis_sold := CASE WHEN v_pos.shares_cash > 0
                         THEN round(v_pos.cost_cash * (-p_delta_shares) / v_pos.shares_cash, 2)
                         ELSE 0 END;
    UPDATE public.open_positions
       SET shares_cash = shares_cash + p_delta_shares,
           cost_cash   = cost_cash - v_basis_sold
     WHERE id = v_pos.id
     RETURNING * INTO v_pos;
  END IF;

  -- ── 11. Book + fee accounting. Creator share ACCRUES on the market row we
  -- already hold — never paid inline. Crediting the creator's wallet here
  -- would couple every trader's fill to a second user row lock (deadlock risk)
  -- and would pay out money that a later void or ban cannot claw back.
  --
  -- v_fee_real is the CASH-funded share of this trade's fee. A sell is always
  -- entirely cash (step 5), and a buy funded entirely from cash sets
  -- v_bonus_used to 0 — both cases make v_fee_real equal v_fee exactly, so
  -- this is byte-identical to v1 whenever bonus is never touched.
  IF p_delta_shares < 0 OR v_bonus_used = 0 THEN
    v_fee_real := v_fee;
  ELSE
    v_fee_real := round(v_fee * v_cash_used / v_total, 4);
  END IF;

  v_accr_before := GREATEST(v_mkt.fees_collected_real - v_mkt.threshold_tngn, 0);
  v_accr_after  := GREATEST(v_mkt.fees_collected_real + v_fee_real - v_mkt.threshold_tngn, 0);

  UPDATE public.open_markets
     SET q                   = v_next,
         fees_collected      = fees_collected + v_fee,
         -- Only the cash-funded portion counts toward the creator threshold —
         -- otherwise free promotional credit would unlock creator payouts,
         -- exactly the loophole this column was created to close.
         fees_collected_real = fees_collected_real + v_fee_real,
         creator_accrued     = creator_accrued
                               + c_creator_share * (v_accr_after - v_accr_before)
   WHERE id = p_market_id;

  -- ── 11b. The FEE is house revenue and must reach the reserve. The v_cost
  -- portion is deliberately NOT credited: it is a liability deposit held
  -- against future payouts, and booking it as revenue would overstate the
  -- reserve by the entire size of the book.
  --
  -- This matters beyond reporting: reserve_health.deployable_tngn is derived
  -- from house_reserve.total_tngn, and place_bet_locked / place_multiplier_slip
  -- size their stake caps off it. An engine that moves real money without
  -- touching the reserve makes the OTHER engines mis-price.
  -- NOTE: the reserve is deliberately NOT touched here. apply_house_pnl_open
  -- locks house_reserve id=1, a platform-wide singleton, and this function
  -- already holds the USER row — while settle_multiplier_market takes them in
  -- the opposite order (apply_house_pnl then credit_user). That is an ABBA
  -- deadlock between the two engines, and it would abort a settlement sweep
  -- mid-payout. It would also serialise every trade on every open market
  -- behind one row, making the whole platform's money path single-threaded.
  --
  -- Fees accrue on the market row this transaction already holds, and a cron
  -- sweeps them to the reserve — exactly the argument already made above for
  -- not paying the creator inline. sweep_open_market_fees moves
  -- fees_collected_real, not fees_collected, so a bonus-funded fee never
  -- inflates the reserve with cash that was never actually deposited.

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, open_market_id, metadata)
  VALUES ('open_trade_fee', v_fee, p_user_id, p_market_id,
          jsonb_build_object('client_trade_id', p_client_trade_id,
                             'outcome_idx', p_outcome_idx,
                             'delta_shares', p_delta_shares,
                             'cost_tngn', v_cost,
                             'fee_real_tngn', v_fee_real,
                             'paid_bonus', v_bonus_used));

  -- ── 12. Immutable log. q_after makes the whole book replayable from here.
  INSERT INTO public.open_trades (
    client_trade_id, market_id, user_id, outcome_idx, delta_shares,
    cost_tngn, fee_tngn, paid_cash, paid_bonus, price_after, q_after, shares_after)
  VALUES (
    p_client_trade_id, p_market_id, p_user_id, p_outcome_idx, p_delta_shares,
    v_cost, v_fee, v_cash_used, v_bonus_used,
    (public.lmsr_prices(v_next, v_mkt.b))[v_idx], v_next,
    v_pos.shares_cash + v_pos.shares_bonus);

  RETURN QUERY SELECT 'executed'::text, v_cost, v_fee, v_total,
                      v_pos.shares_cash + v_pos.shares_bonus,
                      (public.lmsr_prices(v_next, v_mkt.b))[v_idx];
END;
$$;

-- Signature is unchanged, so the existing grants on execute_open_trade stay
-- attached — nothing to REVOKE/GRANT again here.

-- ============================================================================
-- 2. sweep_open_market_fees — sweep REAL fees only, never bonus-funded ones
-- ============================================================================
-- fees_collected is gross (cash + bonus); fees_collected_real excludes the
-- bonus-funded portion. Sweeping against fees_collected would top up
-- house_reserve.total_tngn with money that was never actually deposited —
-- fees_swept now tracks how much of fees_collected_real has reached the
-- reserve, not how much of the gross total has.
CREATE OR REPLACE FUNCTION public.sweep_open_market_fees()
RETURNS TABLE (markets_swept integer, tngn_swept numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_n integer := 0;
  v_total numeric := 0;
  v_delta numeric;
BEGIN
  FOR v_row IN
    SELECT id, fees_collected_real, fees_swept
      FROM public.open_markets
     WHERE fees_collected_real > fees_swept
     ORDER BY id
     FOR UPDATE SKIP LOCKED          -- never block a live trade
  LOOP
    v_delta := v_row.fees_collected_real - v_row.fees_swept;
    IF v_delta <= 0 THEN CONTINUE; END IF;

    PERFORM public.apply_house_pnl_open(v_delta, v_row.id);
    UPDATE public.open_markets SET fees_swept = fees_collected_real WHERE id = v_row.id;

    v_n := v_n + 1;
    v_total := v_total + v_delta;
  END LOOP;

  RETURN QUERY SELECT v_n, v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_open_market_fees() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_open_market_fees() TO service_role;

-- Same column list/order/types as before — fees_unswept_tngn now measured
-- against the real accumulator, matching the sweep function above.
CREATE OR REPLACE VIEW public.open_markets_exposure AS
SELECT
  COALESCE(SUM(b * ln(array_length(outcomes, 1)::numeric)), 0) AS worst_case_tngn,
  COALESCE(SUM(fees_collected), 0)                             AS fees_collected_tngn,
  COALESCE(SUM(fees_collected_real - fees_swept), 0)           AS fees_unswept_tngn,
  COALESCE(SUM(creator_accrued - creator_paid), 0)             AS creator_owed_tngn,
  count(*)                                                     AS live_markets
FROM public.open_markets
WHERE status IN ('open', 'horizon_window', 'halted', 'pending_payout');

REVOKE ALL ON public.open_markets_exposure FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.open_markets_exposure TO service_role;

-- ============================================================================
-- 3. void_open_market — pro_rata payouts split by each position's own mix
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_open_market(
  p_market_id   uuid,
  p_kind        text,      -- 'operational' | 'house_fault'
  p_basis       text,      -- 'pro_rata' | 'cost_basis'
  p_requested_by uuid,
  p_approved_by  uuid,
  p_reason      text,
  p_dry_run     boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, positions integer,
               pool_tngn numeric, gross_tngn numeric, house_topup_tngn numeric,
               locked_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt   public.open_markets%ROWTYPE;
  v_epoch smallint;
  v_pool  numeric;
  v_w     numeric;
  v_pos   integer;
  v_gross numeric;
  v_until timestamptz;
  v_prices numeric[];
BEGIN
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'not_found',0,0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
  END IF;
  IF v_mkt.status NOT IN ('open','closed','halted','horizon_window') THEN
    RETURN QUERY SELECT false,'cannot void from status ' || v_mkt.status,0,
                        0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
  END IF;
  IF p_basis NOT IN ('pro_rata','cost_basis') THEN
    RETURN QUERY SELECT false,'bad basis',0,0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
  END IF;
  IF p_basis = 'cost_basis' THEN
    IF p_kind <> 'house_fault' THEN
      RETURN QUERY SELECT false,'cost_basis requires void_kind=house_fault',0,
                          0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
    END IF;
    IF p_approved_by IS NULL OR p_approved_by = p_requested_by THEN
      RETURN QUERY SELECT false,'cost_basis requires a second approver',0,
                          0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
    END IF;
  END IF;

  v_epoch := COALESCE((SELECT MAX(epoch) FROM public.open_settlements
                        WHERE market_id = p_market_id AND kind = 'void'), -1) + 1;
  v_pool   := public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b);
  v_prices := public.lmsr_prices(v_mkt.q, v_mkt.b);

  SELECT COUNT(*), COALESCE(SUM((shares_cash + shares_bonus) * v_prices[outcome_idx + 1]), 0)
    INTO v_pos, v_w
    FROM public.open_positions
   WHERE market_id = p_market_id AND status = 'open' AND (shares_cash + shares_bonus) > 0;

  IF p_basis = 'cost_basis' THEN
    SELECT COALESCE(SUM(cost_cash + cost_bonus), 0) INTO v_gross
      FROM public.open_positions
     WHERE market_id = p_market_id AND status = 'open' AND (shares_cash + shares_bonus) > 0;
  ELSE
    v_gross := LEAST(v_pool, v_w);
  END IF;

  v_until := now() + make_interval(hours => v_mkt.dispute_window_hours);

  IF p_dry_run THEN
    RETURN QUERY SELECT false,'dry_run',v_pos,v_pool,v_gross,
                        GREATEST(v_gross - v_pool, 0), v_until; RETURN;
  END IF;

  IF p_basis = 'pro_rata' THEN
    -- Split each position's pro-rata payout by the SAME mix its shares were
    -- bought in: bonus-funded shares pay into bonus, never tngn — a void
    -- must not become the cash-out laundering path a sell already refuses to
    -- be. floor() only bounds the TOTAL against the pool; the cash/bonus
    -- split itself loses nothing (bonus takes payout − floor(cash part), not
    -- a second floor), so tngn + bonus always equals the pool-bounded total.
    INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn, bonus)
    SELECT p.id, p.market_id, 'void', v_epoch, 'pro_rata',
           floor(p.payout * p.cash_frac * 100) / 100,
           p.payout - floor(p.payout * p.cash_frac * 100) / 100
      FROM (
        SELECT pos.id, pos.market_id,
               floor(v_pool * ((pos.shares_cash + pos.shares_bonus) * v_prices[pos.outcome_idx + 1])
                     / NULLIF(v_w, 0) * 100) / 100 AS payout,
               CASE WHEN (pos.shares_cash + pos.shares_bonus) > 0
                    THEN pos.shares_cash / (pos.shares_cash + pos.shares_bonus)
                    ELSE 1 END AS cash_frac
          FROM public.open_positions pos
         WHERE pos.market_id = p_market_id AND pos.status = 'open'
           AND (pos.shares_cash + pos.shares_bonus) > 0
      ) p;
  ELSE
    INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn, bonus)
    SELECT p.id, p.market_id, 'void', v_epoch, 'cost_basis', p.cost_cash, p.cost_bonus
      FROM public.open_positions p
     WHERE p.market_id = p_market_id AND p.status = 'open'
       AND (p.shares_cash + p.shares_bonus) > 0;
    -- The shortfall is real house money and is booked as a named loss, not
    -- hidden inside the pool arithmetic.
    IF v_gross > v_pool THEN
      INSERT INTO public.treasury_log (type, amount_tngn, open_market_id, metadata)
      VALUES ('open_void_house_topup', -(v_gross - v_pool), p_market_id,
              jsonb_build_object('reason', p_reason, 'requested_by', p_requested_by,
                                 'approved_by', p_approved_by));
    END IF;
  END IF;

  UPDATE public.open_positions SET status = 'refunded', settled_at = now()
   WHERE market_id = p_market_id AND status = 'open';

  UPDATE public.open_markets
     SET status = 'pending_payout', pending_kind = 'void', payout_phase = 'computed',
         void_kind = p_kind, settlement_locked_until = v_until,
         max_hold_until = now() + interval '14 days'
   WHERE id = p_market_id;

  RETURN QUERY SELECT true,'computed',v_pos,v_pool,v_gross,
                      GREATEST(v_gross - v_pool, 0), v_until;
END;
$$;

REVOKE ALL ON FUNCTION public.void_open_market(uuid,text,text,uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_open_market(uuid,text,text,uuid,uuid,text,boolean) TO service_role;

-- ============================================================================
-- 4. close_horizon_window — 'curve' cash_out/retire payouts, same split fix
-- ============================================================================
-- Only this one function from 20260806050000 changes. open_horizon_window and
-- record_horizon_election are untouched and stay exactly as they are.
CREATE OR REPLACE FUNCTION public.close_horizon_window(
  p_market_id uuid,
  p_next_horizon_at timestamptz DEFAULT NULL,
  p_dry_run   boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, rolled integer, cashed_out integer,
               block_tngn numeric, next_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt    public.open_markets%ROWTYPE;
  v_q_next numeric[];
  v_block  numeric;
  v_w      numeric;
  v_prices numeric[];
  v_leavers integer;
  v_rollers integer;
  v_row    record;
  v_pay    numeric;
  v_retire boolean;
  v_trades bigint;
BEGIN
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'not_found',0,0,0::numeric,NULL::text; RETURN;
  END IF;
  IF v_mkt.status <> 'horizon_window' THEN
    RETURN QUERY SELECT false,'not in a horizon window',0,0,0::numeric,NULL::text; RETURN;
  END IF;
  IF v_mkt.halted_at IS NOT NULL THEN
    -- A halt freezes the clock. Closing the window while halted would force
    -- every pending cash-out into a roll — the house choosing for the user.
    RETURN QUERY SELECT false,'halted — extend the window instead',0,0,0::numeric,NULL::text; RETURN;
  END IF;
  IF v_mkt.horizon_window_closes_at IS NOT NULL AND now() < v_mkt.horizon_window_closes_at THEN
    RETURN QUERY SELECT false,'window still open',0,0,0::numeric,NULL::text; RETURN;
  END IF;

  v_retire := (v_mkt.horizon_count >= 3);

  -- Guards on auto-retire. Each of these would otherwise force an exit on a
  -- book we do not currently trust.
  IF v_retire THEN
    IF EXISTS (SELECT 1 FROM public.open_market_disputes
                WHERE market_id = p_market_id AND status = 'open') THEN
      RETURN QUERY SELECT false,'open dispute blocks retire',0,0,0::numeric,NULL::text; RETURN;
    END IF;
    SELECT COUNT(*) INTO v_trades FROM public.open_trades WHERE market_id = p_market_id;
    IF v_trades > 0 AND NOT EXISTS (SELECT 1 FROM public.open_positions
                                     WHERE market_id = p_market_id AND status = 'open'
                                       AND (shares_cash + shares_bonus) > 0) THEN
      -- Trades happened but nobody holds anything. That is a bug signal, not a
      -- clean market — the same reasoning behind the pending_void queue.
      RETURN QUERY SELECT false,'zero positions but trades exist — queue for review',
                          0,0,0::numeric,NULL::text; RETURN;
    END IF;
  END IF;

  v_prices := public.lmsr_prices(v_mkt.q, v_mkt.b);

  -- Who is leaving. Absence of an election means ROLL: never move a user's
  -- money without instruction. On retire, everyone leaves.
  -- cash_frac carries each leaver's own cash/bonus mix through to the payout
  -- split below — the same reasoning as void_open_market's pro_rata fix:
  -- a forced cash-out must never turn a bonus-funded share into cash.
  CREATE TEMP TABLE IF NOT EXISTS _leavers (
    position_id uuid, user_id uuid, outcome_idx smallint,
    shares numeric, weight numeric, cash_frac numeric) ON COMMIT DROP;
  DELETE FROM _leavers;

  INSERT INTO _leavers
  SELECT p.id, p.user_id, p.outcome_idx,
         p.shares_cash + p.shares_bonus,
         (p.shares_cash + p.shares_bonus) * v_prices[p.outcome_idx + 1],
         CASE WHEN (p.shares_cash + p.shares_bonus) > 0
              THEN p.shares_cash / (p.shares_cash + p.shares_bonus)
              ELSE 1 END
    FROM public.open_positions p
    LEFT JOIN public.open_horizon_elections e
      ON e.position_id = p.id AND e.horizon_no = v_mkt.horizon_count
   WHERE p.market_id = p_market_id AND p.status = 'open'
     AND (p.shares_cash + p.shares_bonus) > 0
     AND (v_retire OR e.choice = 'cash_out');

  SELECT COUNT(*), COALESCE(SUM(weight),0) INTO v_leavers, v_w FROM _leavers;
  SELECT COUNT(*) INTO v_rollers FROM public.open_positions p
   WHERE p.market_id = p_market_id AND p.status = 'open'
     AND (p.shares_cash + p.shares_bonus) > 0
     AND NOT EXISTS (SELECT 1 FROM _leavers l WHERE l.position_id = p.id);

  -- Price the leavers AS ONE BLOCK. This is what makes the stayers whole.
  v_q_next := v_mkt.q;
  FOR v_row IN SELECT outcome_idx, SUM(shares) s FROM _leavers GROUP BY outcome_idx LOOP
    v_q_next[v_row.outcome_idx + 1] := v_q_next[v_row.outcome_idx + 1] - v_row.s;
  END LOOP;
  v_block := CASE WHEN v_leavers = 0 THEN 0
                  ELSE public.lmsr_cost(v_mkt.q, v_mkt.b)
                       - public.lmsr_cost(v_q_next, v_mkt.b) END;

  IF p_dry_run THEN
    RETURN QUERY SELECT false,'dry_run',v_rollers,v_leavers,v_block,
                        CASE WHEN v_retire THEN 'pending_payout' ELSE 'open' END;
    RETURN;
  END IF;

  -- Write a settlement row per leaver: their pro-rata slice OF THE BLOCK,
  -- split cash/bonus by that position's own funding mix. floor() keeps the
  -- residual with the house at the TOTAL level; the split itself loses
  -- nothing (bonus takes payout − floor(cash part)), matching void's fix.
  INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn, bonus)
  SELECT l.position_id, p_market_id,
         CASE WHEN v_retire THEN 'retire' ELSE 'cash_out' END,
         v_mkt.horizon_count, 'curve',
         floor(l.payout * l.cash_frac * 100) / 100,
         l.payout - floor(l.payout * l.cash_frac * 100) / 100
    FROM (SELECT *, floor(v_block * weight / NULLIF(v_w,0) * 100) / 100 AS payout
            FROM _leavers) l
  ON CONFLICT (position_id, kind, epoch) DO NOTHING;

  -- Pay them. Subtransaction per row so one broken account cannot strand the
  -- rest, and released_at is the cursor for a resumed run.
  FOR v_row IN
    SELECT s.id, s.tngn, s.bonus, l.user_id FROM public.open_settlements s
      JOIN _leavers l ON l.position_id = s.position_id
     WHERE s.market_id = p_market_id AND s.epoch = v_mkt.horizon_count
       AND s.released_at IS NULL AND s.attempts < 5
     ORDER BY l.user_id, s.id
  LOOP
    BEGIN
      IF v_row.tngn > 0 OR v_row.bonus > 0 THEN
        PERFORM public.credit_user(v_row.user_id, v_row.tngn, v_row.bonus);
      END IF;
      UPDATE public.open_settlements
         SET released_at = now(), attempts = attempts + 1 WHERE id = v_row.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.open_settlements
         SET attempts = attempts + 1, failed_at = now(), last_error = SQLERRM
       WHERE id = v_row.id;
    END;
  END LOOP;

  UPDATE public.open_positions
     SET status = CASE WHEN v_retire THEN 'settled' ELSE 'cashed_out' END,
         settled_at = now(), shares_cash = 0, shares_bonus = 0
   WHERE id IN (SELECT position_id FROM _leavers);

  IF v_retire THEN
    UPDATE public.open_markets
       SET q = v_q_next, status = 'retired', pending_kind = 'retire',
           payout_phase = 'released', horizon_window_closes_at = NULL
     WHERE id = p_market_id;
    RETURN QUERY SELECT true,'retired',v_rollers,v_leavers,v_block,'retired'::text;
  ELSE
    UPDATE public.open_markets
       SET q = v_q_next, status = 'open',
           horizon_at = p_next_horizon_at,
           horizon_window_closes_at = NULL
     WHERE id = p_market_id;
    RETURN QUERY SELECT true,'rolled',v_rollers,v_leavers,v_block,'open'::text;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.close_horizon_window(uuid,timestamptz,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_horizon_window(uuid,timestamptz,boolean) TO service_role;

-- ============================================================================
-- 5. claim_creator_earnings — replay guard verified against REAL fees
-- ============================================================================
-- The independent replay check here used to sum gross fee_tngn from the trade
-- log. Now that creator_accrued only earns against fees_collected_real, that
-- gross replay is a looser (never wrong, but no longer tight) bound — fixed
-- to recompute the same real-fee figure execute_open_trade accrues against,
-- using paid_cash/paid_bonus (already logged per trade) to recover each
-- trade's cash fraction of its fee without needing a new column.
CREATE OR REPLACE FUNCTION public.claim_creator_earnings(
  p_market_id uuid,
  p_user_id   uuid
)
RETURNS TABLE (applied boolean, reason text, paid_tngn numeric, remaining_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt    public.open_markets%ROWTYPE;
  v_owed   numeric;
  v_replay numeric;
  v_fees   numeric;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Sign in first', 0::numeric, 0::numeric; RETURN;
  END IF;

  -- Locked for the same reason every money path here is: two taps on a slow
  -- connection must not pay the same earnings twice.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found', 0::numeric, 0::numeric; RETURN;
  END IF;
  IF v_mkt.created_by IS NULL OR v_mkt.created_by <> p_user_id THEN
    RETURN QUERY SELECT false, 'This is not your market', 0::numeric, 0::numeric; RETURN;
  END IF;

  v_owed := COALESCE(v_mkt.creator_accrued,0) - COALESCE(v_mkt.creator_paid,0);
  IF v_owed <= 0 THEN
    RETURN QUERY SELECT false,
      CASE WHEN COALESCE(v_mkt.creator_accrued,0) = 0
           THEN 'Nothing earned yet — this market has not passed its threshold'
           ELSE 'Everything earned so far has been paid' END,
      0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- creator_accrued is a running total maintained on the trade path. It is a
  -- cache, and a cache is exactly the thing not to trust when paying out, so
  -- it is replayed from the trade log before any money moves. Paying the
  -- LESSER of the two means a corrupted counter under-pays (recoverable) and
  -- never over-pays (not recoverable).
  --
  -- fee_tngn * paid_cash / (paid_cash + paid_bonus) recovers each trade's
  -- real (cash-funded) fee: a sell always has paid_bonus = 0, so the ratio is
  -- 1 and this equals fee_tngn exactly, same as a cash-only buy.
  SELECT COALESCE(SUM(fee_tngn * paid_cash / NULLIF(paid_cash + paid_bonus, 0)),0) INTO v_fees
    FROM public.open_trades WHERE market_id = p_market_id;
  v_replay := 0.25 * GREATEST(v_fees - COALESCE(v_mkt.threshold_tngn,0), 0);

  IF COALESCE(v_mkt.creator_accrued,0) > v_replay + 0.01 THEN
    v_owed := GREATEST(LEAST(v_owed, v_replay - COALESCE(v_mkt.creator_paid,0)), 0);
    IF v_owed <= 0 THEN
      RETURN QUERY SELECT false,
        'Earnings are under review — the recorded total does not match the fee history',
        0::numeric, 0::numeric;
      RETURN;
    END IF;
  END IF;

  v_owed := floor(v_owed * 100) / 100;   -- residual stays with the house
  IF v_owed <= 0 THEN
    RETURN QUERY SELECT false, 'Too small to pay out yet', 0::numeric,
      COALESCE(v_mkt.creator_accrued,0) - COALESCE(v_mkt.creator_paid,0);
    RETURN;
  END IF;

  -- Market lock is held, user lock is taken after it — the same order
  -- execute_open_trade uses, so these can never deadlock against each other.
  -- credit_user is safe here because this is a CREDIT; its clamp at zero is
  -- only unsound as a debit.
  PERFORM public.credit_user(p_user_id, v_owed, 0);

  UPDATE public.open_markets
     SET creator_paid = COALESCE(creator_paid,0) + v_owed
   WHERE id = p_market_id;

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, open_market_id, metadata)
  VALUES ('open_market_creator_payout', -v_owed, p_user_id, p_market_id,
          jsonb_build_object('fees_at_payout', v_fees,
                             'threshold', v_mkt.threshold_tngn));

  INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
  VALUES (p_user_id, 'open_market_creator_payout',
          'Creator earnings paid: ₦' || to_char(v_owed, 'FM999,999,999.00'),
          v_owed, 'success', '/open/creator');

  RETURN QUERY SELECT true, 'paid', v_owed,
    COALESCE((SELECT creator_accrued - creator_paid FROM public.open_markets
               WHERE id = p_market_id), 0);
END;
$$;

-- Signature unchanged; existing grants stay attached.

-- ============================================================================
-- 6. verify_open_market_book — creator-accrual invariant, same real-fee basis
-- ============================================================================
CREATE OR REPLACE FUNCTION public.verify_open_market_book(p_market_id uuid)
RETURNS TABLE (ok boolean, check_name text, expected numeric, actual numeric, detail text)
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  v_mkt public.open_markets%ROWTYPE;
  i integer;
BEGIN
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'market_exists'::text, NULL::numeric, NULL::numeric,
                        'no such market'::text;
    RETURN;
  END IF;

  -- 1. The book must equal what users actually hold.
  -- This is the money-minted-from-nothing detector: if q says 5,000 shares
  -- exist but positions only account for 4,000, the extra 1,000 would be paid
  -- out at settlement against nothing.
  --
  -- Only meaningful while the market is LIVE. Once settled, positions are
  -- correctly zero while q remains a historical record — so running this on a
  -- terminal market flags every correctly-settled book as critical, and real
  -- alerts drown in false ones. Terminal markets get check 1b instead.
  IF v_mkt.status IN ('open','closed','horizon_window','halted') THEN
  FOR i IN 1 .. array_length(v_mkt.outcomes, 1) LOOP
    RETURN QUERY
    SELECT abs((v_mkt.q[i] - v_mkt.q_initial[i]) - COALESCE(h.held, 0)) < 0.000001,
           'book_matches_holdings[' || (i-1) || ']',
           v_mkt.q[i] - v_mkt.q_initial[i],
           COALESCE(h.held, 0),
           'q minus q_initial must equal the sum of open positions'
      FROM (SELECT SUM(shares_cash + shares_bonus) AS held
              FROM public.open_positions
             WHERE market_id = p_market_id AND outcome_idx = i - 1
               AND status = 'open') h;
  END LOOP;
  ELSE
    -- 1b. Terminal market: EVERY position must have been dealt with, and every
    -- one must have a payout record. A position left 'open' on a resolved
    -- market is money owed to someone that no sweep will ever find.
    RETURN QUERY
    SELECT COUNT(*) = 0, 'no_positions_left_open',
           0::numeric, COUNT(*)::numeric,
           'positions still open on a terminal market'
      FROM public.open_positions
     WHERE market_id = p_market_id AND status = 'open';

    RETURN QUERY
    SELECT COUNT(*) = 0, 'every_position_has_a_payout_record',
           0::numeric, COUNT(*)::numeric,
           'settled positions holding shares but with no open_settlements row'
      FROM public.open_positions p
     WHERE p.market_id = p_market_id
       AND p.status IN ('settled','refunded','cashed_out')
       -- A trader who sold their entire holding before resolution leaves a
       -- zero-share position. It is owed zero, so it correctly has no payout
       -- row. Without this clause the check fired on every fully-exited
       -- holder — see the migration header.
       AND (COALESCE(p.shares_cash,0) + COALESCE(p.shares_bonus,0)) > 0
       AND NOT EXISTS (SELECT 1 FROM public.open_settlements s
                        WHERE s.position_id = p.id);
  END IF;

  -- 2. Positions must equal the trade log. Catches a lost position update.
  RETURN QUERY
  SELECT COUNT(*) = 0, 'positions_match_trades',
         0::numeric, COUNT(*)::numeric,
         'positions whose share count disagrees with their trade history'
    FROM (
      SELECT p.id
        FROM public.open_positions p
        LEFT JOIN (SELECT market_id, user_id, outcome_idx, SUM(delta_shares) net
                     FROM public.open_trades
                    WHERE market_id = p_market_id
                    GROUP BY 1,2,3) t
          ON t.market_id = p.market_id AND t.user_id = p.user_id
         AND t.outcome_idx = p.outcome_idx
       WHERE p.market_id = p_market_id AND p.status = 'open'
         AND abs((p.shares_cash + p.shares_bonus) - COALESCE(t.net, 0)) > 0.000001
    ) bad;

  -- 3. Cash conservation, while the market is still live. A NEGATIVE residual
  -- means rounding is running the wrong way — the exact bug the round-trip
  -- property test caught in lmsr.ts, which would bleed on every trade.
  -- Skipped once unwinding has begun, since q no longer tracks cash-in.
  IF v_mkt.status IN ('open','closed','horizon_window','halted')
     AND v_mkt.horizon_count = 0 THEN
  RETURN QUERY
  SELECT COALESCE(SUM(t.cost_tngn), 0)
           >= (public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b)) - 1,
         'wallets_paid_at_least_the_curve',
         public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b),
         COALESCE(SUM(t.cost_tngn), 0),
         'charged must be >= curve; the gap is house-favourable rounding'
    FROM public.open_trades t WHERE t.market_id = p_market_id;
  END IF;

  -- 4. Fees on the market row must equal the fees in the trade log.
  RETURN QUERY
  SELECT abs(v_mkt.fees_collected - COALESCE(SUM(t.fee_tngn), 0)) < 0.005,
         'fees_match_trade_log', v_mkt.fees_collected, COALESCE(SUM(t.fee_tngn), 0),
         'open_markets.fees_collected vs SUM(open_trades.fee_tngn)'
    FROM public.open_trades t WHERE t.market_id = p_market_id;

  -- 5. Creator accrual replayed from the trade log, not trusted as a cache.
  -- creator_accrued is a running total that a fee reversal cannot unwind, so
  -- it is verified against a replay before any payout is allowed. Replayed
  -- against REAL fees (paid_cash's share of fee_tngn per trade) now that
  -- bonus-funded volume never earns creator accrual.
  RETURN QUERY
  SELECT v_mkt.creator_accrued
           <= 0.25 * GREATEST(COALESCE(SUM(t.fee_tngn * t.paid_cash
                                            / NULLIF(t.paid_cash + t.paid_bonus, 0)), 0)
                               - v_mkt.threshold_tngn, 0) + 0.01,
         'creator_accrual_within_replay',
         0.25 * GREATEST(COALESCE(SUM(t.fee_tngn * t.paid_cash
                                       / NULLIF(t.paid_cash + t.paid_bonus, 0)), 0)
                          - v_mkt.threshold_tngn, 0),
         v_mkt.creator_accrued,
         'accrued must not exceed 25% of REAL fees above the threshold'
    FROM public.open_trades t WHERE t.market_id = p_market_id;

  -- 6. Payouts must never exceed the cash that actually came in, plus the
  -- subsidy the house agreed to put up.
  --
  -- Measured against the TRADE LOG, not the current curve state. After a
  -- horizon cash-out or a retire, q has been unwound toward zero, so
  -- C(q) − C(q_initial) no longer represents what was historically collected —
  -- comparing against it flags every partially-unwound market as critical.
  -- SUM(cost_tngn) is the real cash-in and is unaffected by unwinds.
  RETURN QUERY
  SELECT COALESCE((SELECT SUM(s.tngn + s.bonus) FROM public.open_settlements s
                    WHERE s.market_id = p_market_id), 0)
           <= COALESCE((SELECT SUM(t.cost_tngn) FROM public.open_trades t
                         WHERE t.market_id = p_market_id), 0)
              + v_mkt.b * ln(array_length(v_mkt.outcomes, 1)::numeric) + 1,
         'payouts_within_cash_in_plus_subsidy',
         COALESCE((SELECT SUM(t.cost_tngn) FROM public.open_trades t
                    WHERE t.market_id = p_market_id), 0)
           + v_mkt.b * ln(array_length(v_mkt.outcomes, 1)::numeric),
         COALESCE((SELECT SUM(s.tngn + s.bonus) FROM public.open_settlements s
                    WHERE s.market_id = p_market_id), 0),
         'total ever paid out must be within cash-in + b*ln(N)';
END;
$$;

REVOKE ALL ON FUNCTION public.verify_open_market_book(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_open_market_book(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
