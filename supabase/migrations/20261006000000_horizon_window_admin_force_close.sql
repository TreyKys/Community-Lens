-- ============================================================================
-- Open Markets — let an admin force a horizon window closed
-- ============================================================================
-- close_horizon_window refuses to run until horizon_window_closes_at has
-- passed (72h by default). That gate exists to give holders their full
-- election window — but it also means an admin who already knows the event
-- is over has NO path back to 'open' (and from there to "Close trading" ->
-- resolve) for up to 72h. The resolve admin page had no UI for this status
-- at all, which is exactly what produced the report "why can't I resolve
-- trading markets? It's showing one rubbish horizon window" — the market
-- sits there with no button and no explanation.
--
-- This adds p_force: an admin-only override of the TIME gate alone. Every
-- other guard (halted, open dispute, zero-positions-but-trades-exist) still
-- applies — forcing early never skips the payout-safety checks, it only
-- lets a human decide the review period has served its purpose sooner than
-- 72h. Existing callers (the cron, which never force-closes) are unaffected
-- since p_force defaults to false.
--
-- CREATE OR REPLACE does NOT replace a function whose argument list changed
-- length — it silently creates a second overload instead. With both the old
-- 3-arg and new 4-arg signatures live, a 3-arg call (exactly what the cron
-- sends, and what a 4-arg call omitting p_force would also match via its
-- default) becomes genuinely ambiguous: "function is not unique". Confirmed
-- live in production immediately after applying this migration — the old
-- overload must be dropped first, every time this is replayed.
-- ============================================================================

DROP FUNCTION IF EXISTS public.close_horizon_window(uuid, timestamptz, boolean);

CREATE OR REPLACE FUNCTION public.close_horizon_window(
  p_market_id uuid,
  p_next_horizon_at timestamptz DEFAULT NULL,
  p_dry_run   boolean DEFAULT true,
  p_force     boolean DEFAULT false
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
  IF NOT p_force AND v_mkt.horizon_window_closes_at IS NOT NULL
     AND now() < v_mkt.horizon_window_closes_at THEN
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
  CREATE TEMP TABLE IF NOT EXISTS _leavers (
    position_id uuid, user_id uuid, outcome_idx smallint,
    shares numeric, weight numeric) ON COMMIT DROP;
  DELETE FROM _leavers;

  INSERT INTO _leavers
  SELECT p.id, p.user_id, p.outcome_idx,
         p.shares_cash + p.shares_bonus,
         (p.shares_cash + p.shares_bonus) * v_prices[p.outcome_idx + 1]
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

  -- Write a settlement row per leaver: their pro-rata slice OF THE BLOCK.
  -- floor() keeps the residual with the house so the distribution can never
  -- exceed the block.
  INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn)
  SELECT l.position_id, p_market_id,
         CASE WHEN v_retire THEN 'retire' ELSE 'cash_out' END,
         v_mkt.horizon_count, 'curve',
         floor(v_block * l.weight / NULLIF(v_w,0) * 100) / 100
    FROM _leavers l
  ON CONFLICT (position_id, kind, epoch) DO NOTHING;

  -- Pay them. Subtransaction per row so one broken account cannot strand the
  -- rest, and released_at is the cursor for a resumed run.
  FOR v_row IN
    SELECT s.id, s.tngn, l.user_id FROM public.open_settlements s
      JOIN _leavers l ON l.position_id = s.position_id
     WHERE s.market_id = p_market_id AND s.epoch = v_mkt.horizon_count
       AND s.released_at IS NULL AND s.attempts < 5
     ORDER BY l.user_id, s.id
  LOOP
    BEGIN
      IF v_row.tngn > 0 THEN
        PERFORM public.credit_user(v_row.user_id, v_row.tngn, 0);
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

REVOKE ALL ON FUNCTION public.close_horizon_window(uuid,timestamptz,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_horizon_window(uuid,timestamptz,boolean,boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
