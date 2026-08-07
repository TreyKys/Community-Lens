-- ============================================================================
-- Open Markets — invariants ("the smoke alarm")
-- ============================================================================
-- These answer one question: does the money still add up?
--
-- Built BEFORE the settlement functions on purpose. Every money-moving function
-- calls verify_open_market_book() at the end and refuses to commit if the book
-- no longer balances, so drift is caught at the moment it is created rather
-- than by a user complaint days later.
--
-- The three prior incidents on this platform were all discovered by users. The
-- point of this file is that the fourth is discovered by a machine.
-- ============================================================================

-- ── Per-market book check ──────────────────────────────────────────────────
-- Returns one row per check. ok = false on any row means STOP.
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
           'settled positions with no matching open_settlements row'
      FROM public.open_positions p
     WHERE p.market_id = p_market_id
       AND p.status IN ('settled','refunded','cashed_out')
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

  -- 3. Cash conservation. What the curve says the book holds must be no MORE
  -- than what wallets actually paid in. A NEGATIVE residual means rounding is
  -- running the wrong way — that is the exact bug the round-trip property test
  -- caught in lmsr.ts, and it would bleed on every single trade.
  RETURN QUERY
  SELECT COALESCE(SUM(t.cost_tngn), 0)
           >= (public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b)) - 1,
         'wallets_paid_at_least_the_curve',
         public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b),
         COALESCE(SUM(t.cost_tngn), 0),
         'charged must be >= curve; the gap is house-favourable rounding'
    FROM public.open_trades t WHERE t.market_id = p_market_id;

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

  -- 6. Payouts must never exceed what was collected plus the subsidy bound.
  RETURN QUERY
  SELECT COALESCE(SUM(s.tngn + s.bonus), 0)
           <= (public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b))
              + v_mkt.b * ln(array_length(v_mkt.outcomes, 1)::numeric) + 1,
         'payouts_within_pool_plus_subsidy',
         (public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b))
           + v_mkt.b * ln(array_length(v_mkt.outcomes, 1)::numeric),
         COALESCE(SUM(s.tngn + s.bonus), 0),
         'total settled must be within pool + b*ln(N)'
    FROM public.open_settlements s WHERE s.market_id = p_market_id;
END;
$$;

-- Convenience: true only if every check passes.
CREATE OR REPLACE FUNCTION public.open_market_book_ok(p_market_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT bool_and(ok) FROM public.verify_open_market_book(p_market_id);
$$;

-- ── Platform-wide sweep, for the nightly job ───────────────────────────────
-- Returns only what is WRONG. An empty result is the healthy state.
CREATE OR REPLACE FUNCTION public.scan_open_markets_health()
RETURNS TABLE (severity text, market_id uuid, check_name text,
               expected numeric, actual numeric, detail text)
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE m record;
BEGIN
  -- Per-market book invariants.
  FOR m IN SELECT id FROM public.open_markets
            WHERE status IN ('open','closed','horizon_window','halted',
                             'pending_payout','resolved','voided','retired') LOOP
    RETURN QUERY
    SELECT 'critical'::text, m.id, v.check_name, v.expected, v.actual, v.detail
      FROM public.verify_open_market_book(m.id) v
     WHERE NOT v.ok;
  END LOOP;

  -- Aggregate exposure vs what the house can actually cover. This is the one
  -- number to look at daily.
  RETURN QUERY
  SELECT CASE WHEN e.worst_case_tngn > 0.8 * GREATEST(r.deployable, 1) THEN 'critical'
              WHEN e.worst_case_tngn > 0.6 * GREATEST(r.deployable, 1) THEN 'warning'
              ELSE 'info' END,
         NULL::uuid, 'aggregate_exposure_vs_reserve',
         r.deployable, e.worst_case_tngn,
         'committed worst case across every live open market'
    FROM public.open_markets_exposure e,
         (SELECT GREATEST(COALESCE(total_tngn,0) - COALESCE(floor_tngn,0), 0) AS deployable
            FROM public.house_reserve WHERE id = 1) r
   WHERE e.worst_case_tngn > 0.6 * GREATEST(r.deployable, 1);

  -- Horizon liveness: a market past its horizon that is still 'open' means the
  -- horizon job is dead. It fails silently otherwise.
  RETURN QUERY
  SELECT 'critical'::text, id, 'horizon_job_stalled',
         NULL::numeric, EXTRACT(EPOCH FROM (now() - horizon_at))/3600,
         'market is past its horizon but still open — the horizon cron is not running'
    FROM public.open_markets
   WHERE status = 'open' AND horizon_at IS NOT NULL
     AND horizon_at < now() - interval '1 hour';

  -- Payouts computed but never released. Money owed and not paid.
  RETURN QUERY
  SELECT CASE WHEN max_hold_until IS NOT NULL AND now() > max_hold_until
              THEN 'critical' ELSE 'warning' END,
         m2.id, 'settlements_unreleased',
         NULL::numeric, cnt.n,
         'positions with a computed payout that has not been paid'
    FROM public.open_markets m2
    JOIN LATERAL (SELECT COUNT(*)::numeric n FROM public.open_settlements s
                   WHERE s.market_id = m2.id AND s.released_at IS NULL) cnt ON true
   WHERE cnt.n > 0
     AND m2.settlement_locked_until IS NOT NULL
     AND now() > m2.settlement_locked_until + interval '6 hours';

  -- Fees accrued on markets but never swept into the reserve.
  RETURN QUERY
  SELECT 'warning'::text, NULL::uuid, 'fees_unswept',
         NULL::numeric, e2.fees_unswept_tngn,
         'fee sweep has not run recently — the reserve is understated'
    FROM public.open_markets_exposure e2
   WHERE e2.fees_unswept_tngn > 1000;

  -- Settlements stuck failing.
  RETURN QUERY
  SELECT 'critical'::text, s2.market_id, 'settlement_payout_failing',
         NULL::numeric, COUNT(*)::numeric,
         'payouts that have failed repeatedly and are no longer being retried'
    FROM public.open_settlements s2
   WHERE s2.released_at IS NULL AND s2.attempts >= 5
   GROUP BY s2.market_id;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_open_market_book(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_market_book_ok(uuid)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scan_open_markets_health()    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_open_market_book(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.open_market_book_ok(uuid)     TO service_role;
GRANT EXECUTE ON FUNCTION public.scan_open_markets_health()    TO service_role;

NOTIFY pgrst, 'reload schema';
