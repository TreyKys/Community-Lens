-- Atomic, idempotent single-bet settlement.
--
-- Every winner-credit loop in /api/markets/resolve used to do this as TWO
-- separate network round-trips from Node: credit_user(...) (real money),
-- THEN user_bets.update({status:'won'}). Nothing locked the bet row
-- between them. That's two independent failure/race windows:
--
--   1. credit_user succeeds, then the status-update throws (transient
--      DB error, timeout). The bet is caught into failedBetIds and stays
--      'active'. A resumed resolve call (or the repair-stuck-resolutions
--      tool) re-selects status='active' bets and pays this one AGAIN —
--      the user is credited twice for one bet.
--
--   2. Two resolve calls for the same market genuinely overlap (a slow
--      original request still mid-loop, plus an impatient retry that
--      lands after the claim already committed and takes the "resume"
--      branch). Both SELECT the same status='active' rows before either
--      has flipped them, so both credit_user the same bet.
--
-- settle_multiplier_for_market already avoids both problems by taking a
-- FOR UPDATE row lock and checking status inside one transaction. This
-- does the same for public.user_bets: lock the row, no-op if it's no
-- longer 'active' (idempotent — safe to call again from a resume or a
-- concurrent request, which will simply block on the lock and then see
-- the row already settled), otherwise credit + flip status as one
-- atomic unit. Works for both winners (p_tngn_delta/p_bonus_delta > 0)
-- and losers (both zero) — one RPC replaces both call patterns.

CREATE OR REPLACE FUNCTION public.settle_bet_outcome(
  p_bet_id      uuid,
  p_user_id     uuid,
  p_new_status  text,     -- 'won' or 'lost'
  p_payout_tngn numeric,  -- 0 for a loss
  p_tngn_delta  numeric,  -- 0 for a loss
  p_bonus_delta numeric   -- 0 for a loss
)
RETURNS boolean  -- true if this call applied the settlement; false if the
                 -- bet was already settled by an earlier/concurrent call
                 -- (idempotent no-op — caller should skip points/notify)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_new_status NOT IN ('won', 'lost') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_status FROM public.user_bets WHERE id = p_bet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bet_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Already settled by an earlier pass or a concurrent caller that won
  -- the row lock first. Safe no-op — this is what makes resuming a
  -- stuck resolution (and a genuinely concurrent duplicate request)
  -- idempotent instead of a double-pay.
  IF v_status <> 'active' THEN
    RETURN false;
  END IF;

  IF p_tngn_delta <> 0 OR p_bonus_delta <> 0 THEN
    PERFORM public.credit_user(p_user_id, p_tngn_delta, p_bonus_delta);
  END IF;

  UPDATE public.user_bets SET status = p_new_status, payout_tngn = p_payout_tngn WHERE id = p_bet_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_bet_outcome(uuid, uuid, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_bet_outcome(uuid, uuid, text, numeric, numeric, numeric) TO service_role;

COMMENT ON FUNCTION public.settle_bet_outcome IS
  'Atomically credits (if any delta) and flips a single user_bets row to won/lost, under a row lock, no-op if the bet is no longer active. Replaces separate credit_user + user_bets.update calls in /api/markets/resolve so a partial failure or a concurrent duplicate resolve call can never double-pay the same bet.';

NOTIFY pgrst, 'reload schema';
