-- ============================================================================
-- Open Markets — treasury integration + the halt lever
-- ============================================================================
-- Two gaps found reviewing phase 2, both of which must close BEFORE real money
-- enters the engine.
--
-- ── GAP 1: Open Markets money left wallets into a void ─────────────────────
-- execute_open_trade debits users.tngn_balance and writes nothing to
-- treasury_log or house_reserve. That is not merely an under-reporting problem
-- on the analytics screen — it is CROSS-ENGINE, and the path is precise:
--
--   reserve_health.deployable_tngn = house_reserve.total_tngn − floor_tngn
--   house_reserve.total_tngn only ever moves via apply_house_pnl()
--   place_bet_locked reads deployable_tngn and RAISES 'tier2_paused' when it
--   is low; place_multiplier_slip reads the same view.
--
-- So an Open Markets settlement pays real naira out of user wallets while
-- total_tngn never moves. The locked-odds and Multiplier engines keep sizing
-- their stake caps off a reserve that Open Markets has quietly drained. The
-- damage lands on a different engine than the one that caused it, which is
-- exactly the kind of bug that is impossible to diagnose from the symptom.
--
-- The existing plumbing cannot be reused as-is: treasury_log.market_id,
-- market_liability.market_id and apply_house_pnl's second argument are all
-- `bigint REFERENCES markets(id)`, and open_markets.id is a uuid. Hence a
-- nullable open_market_id column and a uuid-keyed overload.
--
-- ── GAP 2: 'halted' existed as a status with no way to reach it ────────────
-- The status CHECK, halted_by, halted_reason and halted_at were all in the
-- schema, but there was no function, no endpoint and no button — so the only
-- way to stop trading on a leaking market was a hand-written UPDATE in the
-- Supabase console, at whatever hour the leak was noticed. A per-market halt
-- is also not enough when the fault is in the pricing function itself, so this
-- adds an engine-wide kill switch too.
-- ============================================================================

-- ── Treasury log accepts a uuid market ─────────────────────────────────────
ALTER TABLE public.treasury_log
  ADD COLUMN IF NOT EXISTS open_market_id uuid REFERENCES public.open_markets(id);

CREATE INDEX IF NOT EXISTS treasury_log_open_market_idx
  ON public.treasury_log (open_market_id) WHERE open_market_id IS NOT NULL;

-- ── apply_house_pnl overload keyed by uuid ─────────────────────────────────
-- Deliberately a thin wrapper: house_reserve stays the single source of truth
-- for solvency across all three engines, and there is exactly one place that
-- mutates total_tngn.
CREATE OR REPLACE FUNCTION public.apply_house_pnl_open(
  p_pnl_tngn      numeric,
  p_open_market_id uuid
)
RETURNS TABLE (new_total numeric, floor_tngn numeric, deployable numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total numeric;
  v_floor     numeric;
BEGIN
  IF p_pnl_tngn IS NULL THEN
    RAISE EXCEPTION 'apply_house_pnl_open: p_pnl_tngn cannot be null' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.house_reserve hr
     SET total_tngn = COALESCE(hr.total_tngn, 0) + p_pnl_tngn,
         updated_at = now()
   WHERE hr.id = 1
  RETURNING hr.total_tngn, hr.floor_tngn INTO v_new_total, v_floor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_house_pnl_open: house_reserve singleton missing'
      USING ERRCODE = 'P0003';
  END IF;

  RETURN QUERY SELECT v_new_total, v_floor, GREATEST(0, v_new_total - v_floor);
END;
$$;

-- (open_markets_config lives in the schema migration — the trade RPC reads it,
--  and a function body binds late, so creating it later would apply cleanly
--  then fail on the first real trade.)

-- ── Halt / resume a single market ──────────────────────────────────────────
-- Positions are untouched: halting stops trading, it does not settle anything.
CREATE OR REPLACE FUNCTION public.halt_open_market(
  p_market_id uuid,
  p_admin_id  uuid,
  p_reason    text
)
RETURNS TABLE (market_id uuid, previous_status text, new_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_prev text;
BEGIN
  SELECT status INTO v_prev FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_prev NOT IN ('open', 'horizon_window') THEN
    RAISE EXCEPTION 'cannot halt a market in status %', v_prev USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.open_markets
     SET status = 'halted', halted_by = p_admin_id,
         halted_reason = p_reason, halted_at = now()
   WHERE id = p_market_id;

  INSERT INTO public.notifications (user_id, type, message)
  VALUES (NULL, 'admin_alert',
          'Open market halted: ' || COALESCE(p_reason, 'no reason given'));

  RETURN QUERY SELECT p_market_id, v_prev, 'halted'::text;
END;
$$;

-- Resume returns the market to the status it was halted FROM, so halting
-- during a horizon window does not silently drop it back to plain trading.
CREATE OR REPLACE FUNCTION public.resume_open_market(
  p_market_id uuid,
  p_admin_id  uuid,
  p_to_status text DEFAULT 'open'
)
RETURNS TABLE (market_id uuid, new_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_mkt public.open_markets%ROWTYPE;
BEGIN
  IF p_to_status NOT IN ('open', 'horizon_window') THEN
    RAISE EXCEPTION 'can only resume to open or horizon_window' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_mkt.status <> 'halted' THEN
    RAISE EXCEPTION 'market is not halted (status=%)', v_mkt.status USING ERRCODE = 'P0001';
  END IF;

  -- A halt freezes the clock; resuming must not drop the market straight back
  -- into a window that expired while it was stopped.
  IF p_to_status = 'open' AND v_mkt.trading_closes_at IS NOT NULL
     AND v_mkt.trading_closes_at <= now() THEN
    RAISE EXCEPTION 'trading window already expired — extend trading_closes_at first'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.open_markets
     SET status = p_to_status, halted_by = NULL, halted_reason = NULL, halted_at = NULL
   WHERE id = p_market_id;

  RETURN QUERY SELECT p_market_id, p_to_status;
END;
$$;


-- ── Fee sweep: the reserve is updated OUT of the trade path ────────────────
-- execute_open_trade deliberately does not call apply_house_pnl_open. Doing so
-- would take an exclusive lock on house_reserve id=1 while already holding the
-- user row — and settle_multiplier_market takes those two in the opposite
-- order (apply_house_pnl at line 87, credit_user at 124). That is an ABBA
-- deadlock between two engines, and the loser is usually the settlement batch,
-- which rolls back mid-payout and retries into the same deadlock. It would
-- also funnel every trade on every market through one row.
--
-- So fees accrue on the market row the trade already holds, and this sweeps
-- the difference. Idempotent by construction: it only ever moves
-- (fees_collected − fees_swept), so a double run is a no-op.
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
    SELECT id, fees_collected, fees_swept
      FROM public.open_markets
     WHERE fees_collected > fees_swept
     ORDER BY id
     FOR UPDATE SKIP LOCKED          -- never block a live trade
  LOOP
    v_delta := v_row.fees_collected - v_row.fees_swept;
    IF v_delta <= 0 THEN CONTINUE; END IF;

    PERFORM public.apply_house_pnl_open(v_delta, v_row.id);
    UPDATE public.open_markets SET fees_swept = fees_collected WHERE id = v_row.id;

    v_n := v_n + 1;
    v_total := v_total + v_delta;
  END LOOP;

  RETURN QUERY SELECT v_n, v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_open_market_fees() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_open_market_fees() TO service_role;

-- ── Live exposure, the number the treasury actually cares about ────────────
CREATE OR REPLACE VIEW public.open_markets_exposure AS
SELECT
  COALESCE(SUM(b * ln(array_length(outcomes, 1)::numeric)), 0) AS worst_case_tngn,
  COALESCE(SUM(fees_collected), 0)                             AS fees_collected_tngn,
  COALESCE(SUM(fees_collected - fees_swept), 0)                AS fees_unswept_tngn,
  COALESCE(SUM(creator_accrued - creator_paid), 0)             AS creator_owed_tngn,
  count(*)                                                     AS live_markets
FROM public.open_markets
WHERE status IN ('open', 'horizon_window', 'halted', 'pending_payout');

REVOKE ALL ON public.open_markets_exposure FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.open_markets_exposure TO service_role;

REVOKE ALL ON FUNCTION public.apply_house_pnl_open(numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.halt_open_market(uuid, uuid, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_open_market(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_house_pnl_open(numeric, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.halt_open_market(uuid, uuid, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_open_market(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
