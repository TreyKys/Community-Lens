-- Two admin controls the Open Markets tooling never had: deleting a market
-- outright, and adjusting its trading/review timing after it has already
-- opened. Both are written as SECURITY DEFINER RPCs, like every other
-- state-changing action on this engine, rather than a bare table UPDATE from
-- an API route — the same reasoning applies here as everywhere else: the
-- invariant belongs next to the data, not in whichever route happens to call
-- it first.

-- ── Delete ───────────────────────────────────────────────────────────────
--
-- Every table that can reference a market — open_trades, open_positions,
-- open_settlements, open_horizon_elections, treasury_log — already declares
-- that reference as ON DELETE RESTRICT (or the unspecified default, which is
-- the same thing). That means Postgres itself already refuses to delete any
-- market with real money or history attached to it; this function does not
-- add that protection, it exists to turn the resulting raw
-- foreign_key_violation into a message an admin can act on, and to leave an
-- audit trail of who deleted what and why — a market that vanishes with no
-- record of the decision is a worse outcome than the clutter it replaces.
--
-- What CAN be deleted this way, in practice: a submission still in
-- pending_review/revise/rejected, or an approved market nobody ever traded
-- on. A market with even one trade must be voided instead (see
-- void_open_market in 20260806040000) — voiding refunds every holder and
-- keeps the record; deleting erases it, which is only honest when there is
-- nothing to erase.
CREATE OR REPLACE FUNCTION public.admin_delete_open_market(
  p_market_id uuid,
  p_admin_id  uuid,
  p_reason    text
)
RETURNS TABLE (applied boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt public.open_markets%ROWTYPE;
BEGIN
  IF p_admin_id IS NULL THEN
    RETURN QUERY SELECT false, 'Admin identity required'; RETURN;
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    RETURN QUERY SELECT false, 'Say why this is being deleted'; RETURN;
  END IF;

  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found'; RETURN;
  END IF;

  BEGIN
    DELETE FROM public.open_markets WHERE id = p_market_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN QUERY SELECT false,
      'This market has real trades, positions or settlements attached — delete is refused. Void it instead, which refunds every holder and keeps the record.';
    RETURN;
  END;

  -- Logged AFTER the row is gone: a treasury_log row pointing at this market
  -- would itself become a reference that blocks the very delete it is
  -- describing, so the market's id travels in the metadata instead.
  INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
  VALUES ('admin_alert', 0, NULL, jsonb_build_object(
    'action', 'open_market_deleted',
    'market_id', p_market_id,
    'question', v_mkt.question,
    'status_at_deletion', v_mkt.status,
    'admin_id', p_admin_id,
    'reason', p_reason
  ));

  RETURN QUERY SELECT true, 'deleted';
END;
$$;

-- ── Reschedule ───────────────────────────────────────────────────────────
--
-- trading_closes_at and horizon_at are only ever set once, at approval, by
-- review_open_market. Nothing since has let an admin correct either one on a
-- market that is already open — and dates set weeks in advance are exactly
-- the kind of thing that turns out wrong (an event gets postponed, a review
-- date needs to move earlier). The validation here is the same review_open_
-- market already enforces at approval time, just re-checked against
-- whatever the market's state is NOW rather than at open.
CREATE OR REPLACE FUNCTION public.admin_reschedule_open_market(
  p_market_id         uuid,
  p_admin_id          uuid,
  p_trading_closes_at timestamptz,
  p_horizon_at        timestamptz
)
RETURNS TABLE (applied boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt public.open_markets%ROWTYPE;
BEGIN
  IF p_admin_id IS NULL THEN
    RETURN QUERY SELECT false, 'Admin identity required'; RETURN;
  END IF;

  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found'; RETURN;
  END IF;
  IF v_mkt.status NOT IN ('open', 'horizon_window') THEN
    RETURN QUERY SELECT false,
      'Only an open market can be rescheduled (this one is ' || v_mkt.status || ')';
    RETURN;
  END IF;

  IF p_trading_closes_at IS NULL THEN
    RETURN QUERY SELECT false, 'Set the time trading stops'; RETURN;
  END IF;
  IF p_trading_closes_at <= now() THEN
    RETURN QUERY SELECT false, 'The closing time is already in the past'; RETURN;
  END IF;
  IF p_horizon_at IS NOT NULL AND p_horizon_at >= p_trading_closes_at THEN
    RETURN QUERY SELECT false, 'The review date must fall before trading closes'; RETURN;
  END IF;

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, open_market_id, metadata)
  VALUES ('admin_alert', 0, NULL, p_market_id, jsonb_build_object(
    'action', 'open_market_rescheduled',
    'admin_id', p_admin_id,
    'previous_trading_closes_at', v_mkt.trading_closes_at,
    'previous_horizon_at', v_mkt.horizon_at,
    'new_trading_closes_at', p_trading_closes_at,
    'new_horizon_at', p_horizon_at
  ));

  UPDATE public.open_markets
     SET trading_closes_at = p_trading_closes_at,
         horizon_at        = p_horizon_at
   WHERE id = p_market_id;

  RETURN QUERY SELECT true, 'rescheduled';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_open_market(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_open_market(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_reschedule_open_market(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reschedule_open_market(uuid,uuid,timestamptz,timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
