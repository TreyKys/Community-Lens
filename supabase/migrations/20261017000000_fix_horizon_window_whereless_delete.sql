-- ============================================================================
-- Fix: horizon windows never auto-close ("rubbish horizon window")
-- ============================================================================
-- close_horizon_window contained `DELETE FROM _leavers;` with no WHERE clause.
-- Supabase runs PostgREST (the service-role REST connection that supabase.rpc
-- uses) with a safeupdate guard that REJECTS any WHERE-less DELETE/UPDATE —
-- it raises "DELETE requires a WHERE clause". The Management API SQL console
-- does NOT have that guard, which is why the function tested fine by hand but
-- failed every single time the cron (/api/cron/open-markets) called it.
--
-- Net effect, live in production since the function was first written: EVERY
-- horizon window that ever opened got stuck in status='horizon_window' forever,
-- because the cron's close step threw on the first statement and the market was
-- never rolled back to 'open'. Admins then saw markets they could not resolve
-- (settlement requires status='closed', unreachable from 'horizon_window'),
-- i.e. "why can't I resolve trading markets — it's showing one rubbish horizon
-- window." The admin force-close button added in 20261006 hit the same wall.
--
-- Fix is one line: give the DELETE a WHERE clause. The temp table is fresh per
-- call (ON COMMIT DROP), so `WHERE true` clears it exactly as before and the
-- guard is satisfied. Body is otherwise the verbatim live definition.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.close_horizon_window(p_market_id uuid, p_next_horizon_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dry_run boolean DEFAULT true, p_force boolean DEFAULT false)
 RETURNS TABLE(applied boolean, reason text, rolled integer, cashed_out integer, block_tngn numeric, next_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  DELETE FROM _leavers WHERE true;   -- WHERE required: PostgREST's safeupdate guard blocks WHERE-less DELETE/UPDATE

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
$function$;


REVOKE ALL ON FUNCTION public.close_horizon_window(uuid,timestamptz,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_horizon_window(uuid,timestamptz,boolean,boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
