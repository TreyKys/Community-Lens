-- ============================================================================
-- Open Markets — LMSR pricing + the atomic trade RPC
-- ============================================================================
-- The cost of a trade MUST be computed from the market row this transaction
-- holds a lock on. Quoting in Node and passing a price in would reintroduce
-- exactly the race this design exists to prevent: two concurrent buys pricing
-- off the same stale book both fill cheap, and value is minted from nothing.
-- ============================================================================

-- ── LMSR cost function, log-sum-exp ────────────────────────────────────────
-- C(q) = b·ln(Σ exp(qᵢ/b)), rewritten as m + b·ln(Σ exp((qᵢ−m)/b)).
--
-- Subtracting the max means every exponent is <= 0, so exp() is always in
-- (0, 1]. That removes the overflow entirely and lets this stay in `numeric`
-- (exact) instead of dropping to double precision, where the arithmetic is
-- non-associative and two mathematically identical trade sequences can produce
-- different books.
CREATE OR REPLACE FUNCTION public.lmsr_cost(p_q numeric[], p_b numeric)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_m   numeric;
  v_sum numeric;
BEGIN
  IF p_b IS NULL OR p_b <= 0 THEN
    RAISE EXCEPTION 'lmsr_cost: b must be positive';
  END IF;
  SELECT max(v) INTO v_m FROM unnest(p_q) AS v;
  SELECT sum(exp((v - v_m) / p_b)) INTO v_sum FROM unnest(p_q) AS v;
  RETURN v_m + p_b * ln(v_sum);
END;
$$;

-- ── Prices (= implied probabilities). Always sum to 1. ─────────────────────
CREATE OR REPLACE FUNCTION public.lmsr_prices(p_q numeric[], p_b numeric)
RETURNS numeric[]
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_m numeric; v_sum numeric; v_out numeric[];
BEGIN
  SELECT max(v) INTO v_m FROM unnest(p_q) AS v;
  SELECT sum(exp((v - v_m) / p_b)) INTO v_sum FROM unnest(p_q) AS v;
  SELECT array_agg(exp((v - v_m) / p_b) / v_sum ORDER BY o) INTO v_out
    FROM unnest(p_q) WITH ORDINALITY AS t(v, o);
  RETURN v_out;
END;
$$;

-- ── Read-only quote, for the UI ────────────────────────────────────────────
-- Advisory only. The executing RPC recomputes under the lock; this exists so
-- the order ticket can show cost, average price and the round-trip cost of
-- exiting before the user commits.
CREATE OR REPLACE FUNCTION public.quote_open_trade(
  p_market_id   uuid,
  p_outcome_idx integer,
  p_delta_shares numeric
)
RETURNS TABLE (cost_tngn numeric, fee_tngn numeric, total_tngn numeric,
               avg_price numeric, price_after numeric)
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  c_fee_pct constant numeric := 0.015;
  v_mkt public.open_markets%ROWTYPE;
  v_next numeric[]; v_raw numeric; v_cost numeric; v_fee numeric;
BEGIN
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'market not found'; END IF;

  v_next := v_mkt.q;
  v_next[p_outcome_idx + 1] := v_next[p_outcome_idx + 1] + p_delta_shares;

  v_raw  := public.lmsr_cost(v_next, v_mkt.b) - public.lmsr_cost(v_mkt.q, v_mkt.b);
  v_cost := ceil(v_raw * 100) / 100;                       -- house-favourable both ways
  v_fee  := GREATEST(ceil(abs(v_cost) * c_fee_pct * 100) / 100, 0.01);

  RETURN QUERY SELECT
    v_cost, v_fee, v_cost + v_fee,
    abs(v_cost) / NULLIF(abs(p_delta_shares), 0),
    (public.lmsr_prices(v_next, v_mkt.b))[p_outcome_idx + 1];
END;
$$;

-- ============================================================================
-- execute_open_trade — the only way shares ever change hands
-- ============================================================================
-- Lock order is ALWAYS market -> user. Every batch job (settle, void, horizon)
-- must take the market lock first or it will deadlock against live traders.
--
-- v1 is CASH ONLY. bonus_balance is deliberately not spendable here: LMSR
-- round-trips are free and a complete set costs exactly its payout, so mixing
-- two currencies with different withdrawal rights turns the engine into a
-- ~98%-efficient bonus->cash converter that needs no prediction at all. The
-- position table carries share LOTS so bonus can be added later deliberately,
-- with its own no-sell rules, rather than retrofitted onto a scalar.
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
  v_total    numeric;
  v_cash     numeric;
  v_other    numeric;
  v_accr_before numeric;
  v_accr_after  numeric;
BEGIN
  -- ── 1. Idempotency FIRST. A committed trade whose response was lost must
  -- replay, not re-execute. The row lock prevents interleaving; only this
  -- prevents repetition.
  SELECT * INTO v_prior FROM public.open_trades
   WHERE client_trade_id = p_client_trade_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'already_executed'::text, v_prior.cost_tngn, v_prior.fee_tngn,
                        v_prior.cost_tngn + v_prior.fee_tngn,
                        COALESCE((SELECT shares_cash + shares_bonus FROM public.open_positions
                                   WHERE market_id = v_prior.market_id
                                     AND user_id = v_prior.user_id
                                     AND outcome_idx = v_prior.outcome_idx), 0),
                        v_prior.price_after;
    RETURN;
  END IF;

  -- ── 2. Lock the market. This serialises every trader on this book.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_mkt.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open (status=%)', v_mkt.status USING ERRCODE = 'P0001';
  END IF;
  IF v_mkt.trading_closes_at IS NOT NULL AND now() >= v_mkt.trading_closes_at THEN
    RAISE EXCEPTION 'trading closed' USING ERRCODE = 'P0001';
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

  v_n := array_length(v_mkt.outcomes, 1);
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

  -- ── 5. No naked shorts. Selling shares you don't hold is borrowing from the
  -- house: proceeds asymptote to b·ln(N) while the liability grows linearly,
  -- so the house's loss is unbounded rather than capped.
  IF p_delta_shares < 0 AND v_held + p_delta_shares < 0 THEN
    RAISE EXCEPTION 'cannot sell more shares than held' USING ERRCODE = 'P0001';
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

  -- ── 7. Price from the LOCKED book.
  v_next := v_mkt.q;
  v_next[v_idx] := v_next[v_idx] + p_delta_shares;
  v_raw  := public.lmsr_cost(v_next, v_mkt.b) - public.lmsr_cost(v_mkt.q, v_mkt.b);

  -- ceil() is house-favourable in BOTH directions: on a buy it raises what the
  -- user pays; on a sell the cost is negative, so ceil moves it toward zero and
  -- shrinks what the user receives. Flooring a sell would hand out a fraction
  -- of a kobo on every single exit.
  v_cost := ceil(v_raw * 100) / 100;

  IF abs(v_cost) < c_min_trade THEN
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
  SELECT tngn_balance INTO v_cash FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_delta_shares > 0 THEN
    IF COALESCE(v_cash, 0) < v_total THEN
      RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.users SET tngn_balance = tngn_balance - v_total WHERE id = p_user_id;
  ELSE
    UPDATE public.users SET tngn_balance = tngn_balance + (-v_total) WHERE id = p_user_id;
  END IF;

  -- ── 10. Position lots. v1 is cash-only, so everything lands in the cash lot.
  IF v_pos.id IS NULL THEN
    INSERT INTO public.open_positions (market_id, user_id, outcome_idx, shares_cash, cost_cash)
    VALUES (p_market_id, p_user_id, p_outcome_idx, p_delta_shares, v_total)
    RETURNING * INTO v_pos;
  ELSE
    UPDATE public.open_positions
       SET shares_cash = shares_cash + p_delta_shares,
           cost_cash   = cost_cash   + v_total
     WHERE id = v_pos.id
     RETURNING * INTO v_pos;
  END IF;

  -- ── 11. Book + fee accounting. Creator share ACCRUES on the market row we
  -- already hold — never paid inline. Crediting the creator's wallet here
  -- would couple every trader's fill to a second user row lock (deadlock risk)
  -- and would pay out money that a later void or ban cannot claw back.
  v_accr_before := GREATEST(v_mkt.fees_collected - v_mkt.threshold_tngn, 0);
  v_accr_after  := GREATEST(v_mkt.fees_collected + v_fee - v_mkt.threshold_tngn, 0);

  UPDATE public.open_markets
     SET q                   = v_next,
         fees_collected      = fees_collected + v_fee,
         fees_collected_real = fees_collected_real + v_fee,
         creator_accrued     = creator_accrued
                               + c_creator_share * (v_accr_after - v_accr_before)
   WHERE id = p_market_id;

  -- ── 12. Immutable log. q_after makes the whole book replayable from here.
  INSERT INTO public.open_trades (
    client_trade_id, market_id, user_id, outcome_idx, delta_shares,
    cost_tngn, fee_tngn, paid_cash, paid_bonus, price_after, q_after)
  VALUES (
    p_client_trade_id, p_market_id, p_user_id, p_outcome_idx, p_delta_shares,
    v_cost, v_fee, v_total, 0,
    (public.lmsr_prices(v_next, v_mkt.b))[v_idx], v_next);

  RETURN QUERY SELECT 'executed'::text, v_cost, v_fee, v_total,
                      v_pos.shares_cash + v_pos.shares_bonus,
                      (public.lmsr_prices(v_next, v_mkt.b))[v_idx];
END;
$$;

REVOKE ALL ON FUNCTION public.lmsr_cost(numeric[], numeric)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lmsr_prices(numeric[], numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quote_open_trade(uuid, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_open_trade(uuid, uuid, uuid, integer, numeric, numeric)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.lmsr_cost(numeric[], numeric)   TO service_role;
GRANT EXECUTE ON FUNCTION public.lmsr_prices(numeric[], numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.quote_open_trade(uuid, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.execute_open_trade(uuid, uuid, uuid, integer, numeric, numeric)
  TO service_role;

COMMENT ON FUNCTION public.execute_open_trade IS
  'Atomic, idempotent LMSR trade. SERVICE ROLE ONLY — it takes p_user_id as a '
  'parameter, so granting it to authenticated would let any signed-in user '
  'trade from any other wallet. Lock order: market -> user.';

NOTIFY pgrst, 'reload schema';
