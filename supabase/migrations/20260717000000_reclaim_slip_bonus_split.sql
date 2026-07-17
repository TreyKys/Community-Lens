-- ============================================================================
-- reclaim_slip_bonus_split — repair an ALREADY-SETTLED Multiplier slip that was
-- paid out with the wrong bonus_proportion (the 20260710010000 regression stamped
-- proportion = 0, so winnings/void-refunds were credited 100% to withdrawable
-- cash instead of split back to bonus).
-- ============================================================================
-- Unlike an active slip (where flipping bonus_proportion is enough because the
-- money hasn't moved), a settled slip already credited the wallet. Fixing it
-- means MOVING money: claw the over-paid cash back into bonus so the wallet
-- matches what the correct split would have produced.
--
-- This function is:
--   * atomic          — user row locked FOR UPDATE for the whole adjustment
--   * idempotent       — anchored on a treasury_log row keyed by slip_id; a
--                        second call is a no-op (reason = 'already_reclaimed')
--   * clamp-honest     — if the user already withdrew/spent the cash, we can
--                        only claw back what is actually in the wallet; the
--                        unrecoverable remainder is reported as `shortfall`
--                        (we NEVER credit bonus we couldn't remove from cash,
--                        so no money is fabricated)
--   * money-conserving — bonus_add always equals the cash actually removed
--
-- Scope: won and voided slips only. Lost slips moved no payout, so proportion
-- has no monetary effect — nothing to reclaim. Active slips are handled by the
-- proportion-flip path in the app, not here.
--
-- Records the correction to treasury_log with type 'slip_settled_bonus_reclaim'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reclaim_slip_bonus_split(
  p_slip_id           uuid,
  p_target_proportion numeric,
  p_dry_run           boolean DEFAULT true
)
RETURNS TABLE (
  slip_id        uuid,
  status         text,
  applied        boolean,
  reason         text,
  credited_base  numeric,   -- the payout/refund the split is applied to
  from_cash      numeric,   -- cash the slip currently holds (per recorded prop)
  to_cash        numeric,   -- cash it should hold at the target proportion
  cash_moved     numeric,   -- cash actually clawed out of the wallet (>= 0)
  bonus_added    numeric,   -- bonus actually added (== cash_moved)
  shortfall      numeric    -- intended move that couldn't be recovered (>= 0)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slip        public.multiplier_slips%ROWTYPE;
  v_recorded    numeric;
  v_base        numeric;
  v_from_cash   numeric;
  v_to_cash     numeric;
  v_intended    numeric;   -- signed: positive = move cash->bonus (clawback)
  v_avail       numeric;
  v_move        numeric;   -- actual cash removed from wallet
  v_bonus_add   numeric;
  v_short       numeric;
  v_user_bal    numeric;
BEGIN
  IF p_target_proportion IS NULL OR p_target_proportion < 0 OR p_target_proportion > 1 THEN
    RAISE EXCEPTION 'target proportion must be between 0 and 1, got %', p_target_proportion;
  END IF;

  -- Lock the slip's owner row for the whole adjustment (credit_user re-locks the
  -- same row; taking it here first keeps the read + write consistent).
  SELECT * INTO v_slip FROM public.multiplier_slips WHERE id = p_slip_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT p_slip_id, NULL::text, false, 'not_found', NULL::numeric,
                        NULL::numeric, NULL::numeric, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- Only settled slips that actually paid out can be reclaimed.
  IF v_slip.status NOT IN ('won', 'voided') THEN
    RETURN QUERY SELECT v_slip.id, v_slip.status, false,
                        CASE WHEN v_slip.status = 'lost' THEN 'lost_no_payout' ELSE 'not_settled' END,
                        NULL::numeric, NULL::numeric, NULL::numeric, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- Idempotency guard: has this slip already been reclaimed?
  IF EXISTS (
    SELECT 1 FROM public.treasury_log
    WHERE type = 'slip_settled_bonus_reclaim'
      AND (metadata->>'slip_id') = p_slip_id::text
  ) THEN
    RETURN QUERY SELECT v_slip.id, v_slip.status, false, 'already_reclaimed',
                        NULL::numeric, NULL::numeric, NULL::numeric, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  v_recorded := COALESCE(v_slip.bonus_proportion, 0);
  IF v_recorded = p_target_proportion THEN
    RETURN QUERY SELECT v_slip.id, v_slip.status, false, 'already_at_target',
                        NULL::numeric, NULL::numeric, NULL::numeric, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- The base amount the split was applied to at settlement, and the cash the
  -- slip currently holds vs. what the target proportion would give.
  --   won:    payout split by the bonus-winnings ladder
  --   voided: refund split linearly by (1 - proportion)
  v_base := COALESCE(v_slip.final_payout_tngn, 0);
  IF v_slip.status = 'won' THEN
    SELECT tngn_amount INTO v_from_cash FROM public.bonus_winnings_split(v_base, v_recorded);
    SELECT tngn_amount INTO v_to_cash   FROM public.bonus_winnings_split(v_base, p_target_proportion);
  ELSE  -- voided
    v_from_cash := round(v_base * (1 - v_recorded), 4);
    v_to_cash   := round(v_base * (1 - p_target_proportion), 4);
  END IF;

  -- Intended cash movement out of the withdrawable wallet (positive = clawback).
  v_intended := v_from_cash - v_to_cash;

  IF v_intended <= 0 THEN
    -- Target keeps at least as much cash as now — nothing to claw back. (For
    -- raising proportion toward 1.0 this never happens; guarded for safety.)
    RETURN QUERY SELECT v_slip.id, v_slip.status, false, 'no_clawback_needed',
                        v_base, v_from_cash, v_to_cash, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- Clamp the clawback to what the wallet actually holds — we cannot remove cash
  -- the user has already withdrawn or spent. Add to bonus only what we removed.
  SELECT COALESCE(tngn_balance, 0) INTO v_user_bal
  FROM public.users WHERE id = v_slip.user_id FOR UPDATE;

  v_avail     := GREATEST(v_user_bal, 0);
  v_move      := LEAST(v_intended, v_avail);
  v_bonus_add := v_move;
  v_short     := v_intended - v_move;

  IF p_dry_run THEN
    RETURN QUERY SELECT v_slip.id, v_slip.status, false, 'dry_run',
                        v_base, v_from_cash, v_to_cash, v_move, v_bonus_add, v_short;
    RETURN;
  END IF;

  IF v_move > 0 THEN
    PERFORM public.credit_user(v_slip.user_id, -v_move, v_bonus_add);
  END IF;

  -- Reflect the corrected funding source on the slip record (so re-reads and any
  -- future recompute agree with the money that now sits in the wallets).
  UPDATE public.multiplier_slips
    SET bonus_proportion = p_target_proportion
  WHERE id = v_slip.id;

  -- Idempotency anchor + audit trail. amount_tngn is the cash moved out of the
  -- withdrawable wallet (negative), matching the direction of the adjustment.
  -- (A slip spans multiple legs/markets, so there is no single market_id to
  -- attribute this to; leave market_id null.)
  INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
  VALUES (
    'slip_settled_bonus_reclaim',
    -v_move,
    v_slip.user_id,
    jsonb_build_object(
      'slip_id',            v_slip.id::text,
      'slip_status',        v_slip.status,
      'from_proportion',    v_recorded,
      'to_proportion',      p_target_proportion,
      'credited_base',      v_base,
      'from_cash',          v_from_cash,
      'to_cash',            v_to_cash,
      'cash_moved',         v_move,
      'bonus_added',        v_bonus_add,
      'shortfall',          v_short,
      'reason',             'bonus_regression_20260710010000_settled_repair'
    )
  );

  RETURN QUERY SELECT v_slip.id, v_slip.status, true, 'applied',
                      v_base, v_from_cash, v_to_cash, v_move, v_bonus_add, v_short;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_slip_bonus_split(uuid, numeric, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_slip_bonus_split(uuid, numeric, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
