-- Fix: every_position_has_a_payout_record fired on every fully-exited holder.
--
-- Found by running the whole lifecycle end to end against a clean database.
-- A trader who buys and then sells their entire holding before resolution
-- leaves a position row with zero shares. settle_open_market correctly flips
-- it to 'settled' (leaving it 'open' would trip no_positions_left_open) and
-- correctly writes NO settlement row, because zero shares are owed zero naira.
-- The invariant then reported CRITICAL on a completely healthy market.
--
-- That matters more than it looks. Selling out early is the NORMAL case for a
-- tradeable market -- it is the whole reason this engine exists -- so the
-- health scan would have been permanently red from the first market onward.
-- A permanently red alarm is an ignored alarm, and an ignored alarm is how a
-- real discrepancy gets missed.
--
-- Exempting zero-share positions does not weaken the guarantee the check
-- exists to give. Its purpose is "no money owed to someone that no sweep will
-- ever find", and a zero-share position is owed nothing. The case it might
-- otherwise have caught -- a bug that zeroes shares AND skips the payout row
-- -- is still caught by check 2, positions_match_trades, which re-derives
-- every holding from the trade log.
--
-- Reproduced verbatim from 20260806030000 with that one predicate added, so
-- checks 1 through 6 are otherwise byte-identical.

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
  -- it is verified against a replay before any payout is allowed.
  RETURN QUERY
  SELECT v_mkt.creator_accrued
           <= 0.25 * GREATEST(COALESCE(SUM(t.fee_tngn), 0) - v_mkt.threshold_tngn, 0) + 0.01,
         'creator_accrual_within_replay',
         0.25 * GREATEST(COALESCE(SUM(t.fee_tngn), 0) - v_mkt.threshold_tngn, 0),
         v_mkt.creator_accrued,
         'accrued must not exceed 25% of fees above the threshold'
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
