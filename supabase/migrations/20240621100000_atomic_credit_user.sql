-- Atomic balance credit RPC for the resolve/payout flow.
--
-- /api/markets/resolve credits winnings to tngn_balance and bet-insurance
-- refunds to bonus_balance with read-then-write updates. Two concurrent
-- resolution calls (or any other concurrent credit) on the same user
-- could race and silently overwrite. This RPC takes deltas and applies
-- them inside a row-level lock — race-safe and clamps bonus at zero so
-- a negative-bonus float can't sneak in.

CREATE OR REPLACE FUNCTION public.credit_user(
  p_user_id uuid,
  p_tngn_delta numeric DEFAULT 0,
  p_bonus_delta numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_tngn numeric;
  v_new_bonus numeric;
BEGIN
  UPDATE public.users
  SET tngn_balance  = GREATEST(COALESCE(tngn_balance,  0) + p_tngn_delta,  0),
      bonus_balance = GREATEST(COALESCE(bonus_balance, 0) + p_bonus_delta, 0)
  WHERE id = p_user_id
  RETURNING tngn_balance, bonus_balance INTO v_new_tngn, v_new_bonus;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'tngn_balance', v_new_tngn,
    'bonus_balance', v_new_bonus
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.credit_user(uuid, numeric, numeric) TO authenticated, service_role;
