-- Launch-night hardening: tighten RLS on user_bets + atomic withdrawal RPCs.
-- Audit found three classes of bug right before launch:
--   1. user_bets had a "USING (true)" read policy from the first migration —
--      any signed-in user could read every other user's bet history.
--   2. /api/withdraw deducted balance via read-then-write, which races on
--      concurrent withdrawals and lets a user double-withdraw.
--   3. /api/admin/withdrawals/reject refunds via read-then-write too, which
--      can lose the refund if either side fails between the two queries.

-- ── 1. user_bets RLS lockdown ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anonymous read access to bets" ON public.user_bets;
DROP POLICY IF EXISTS "Allow anonymous insert access to bets" ON public.user_bets;

-- Read: only own rows. Admin pages use the service role and bypass RLS.
CREATE POLICY "Users read their own bets"
  ON public.user_bets FOR SELECT
  USING (auth.uid() = user_id);

-- Insert: only own rows. (Bet placement actually flows through the
-- place_bet RPC which uses SECURITY DEFINER, but keep this guard for
-- direct-insert safety.)
CREATE POLICY "Users insert their own bets"
  ON public.user_bets FOR INSERT
  WITH CHECK (auth.uid() = user_id);


-- ── 2. Atomic request_withdrawal RPC ──────────────────────────────────────
-- Locks the user row, checks balance, deducts, inserts the withdrawal
-- record, and logs the fee — all inside one transaction. Concurrent
-- withdrawal requests now serialize on FOR UPDATE so no double-spend.
CREATE OR REPLACE FUNCTION public.request_withdrawal(
  p_user_id uuid,
  p_amount_tngn numeric,
  p_spread numeric,
  p_flat_fee numeric,
  p_naira_to_send numeric,
  p_bank_code text,
  p_account_number text,
  p_account_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_balance numeric;
  v_withdrawal_id uuid;
BEGIN
  -- Row lock the user — concurrent /api/withdraw calls block here.
  SELECT tngn_balance INTO v_current_balance
  FROM public.users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  IF (COALESCE(v_current_balance, 0)) < p_amount_tngn THEN
    RAISE EXCEPTION 'Insufficient balance' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.users
  SET tngn_balance = COALESCE(tngn_balance, 0) - p_amount_tngn
  WHERE id = p_user_id;

  INSERT INTO public.withdrawals (
    user_id, amount_tngn, spread_amount, flat_fee, naira_to_send,
    bank_code, account_number, account_name,
    status, gateway, requires_admin_approval, created_at
  ) VALUES (
    p_user_id, p_amount_tngn, p_spread, p_flat_fee, p_naira_to_send,
    p_bank_code, p_account_number, p_account_name,
    'pending_admin_approval', NULL, true, now()
  )
  RETURNING id INTO v_withdrawal_id;

  INSERT INTO public.treasury_movements (
    user_id, type, gateway, direction, amount_ngn, reference, metadata
  ) VALUES (
    p_user_id, 'spread', NULL, 'in',
    p_spread + p_flat_fee, v_withdrawal_id,
    jsonb_build_object('source', 'withdrawal_fee')
  );

  RETURN jsonb_build_object(
    'withdrawal_id', v_withdrawal_id,
    'new_balance', v_current_balance - p_amount_tngn
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_withdrawal(uuid, numeric, numeric, numeric, numeric, text, text, text) TO authenticated, service_role;


-- ── 3. Atomic reject_withdrawal RPC ───────────────────────────────────────
-- Refunds + status-flip + treasury reversal inside one transaction. Also
-- guards on the status — if the row was already rejected we no-op and
-- return null, so a double-click on the admin button can't double-refund.
CREATE OR REPLACE FUNCTION public.reject_withdrawal(
  p_withdrawal_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_w record;
  v_refund_amount numeric;
BEGIN
  -- Lock the withdrawal row so two reject clicks serialize.
  SELECT * INTO v_w
  FROM public.withdrawals
  WHERE id = p_withdrawal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already processed → no-op, idempotent.
  IF v_w.status IN ('rejected', 'refunded', 'completed', 'transfer_initiated') THEN
    RETURN jsonb_build_object('status', 'already_processed', 'previous_status', v_w.status);
  END IF;

  v_refund_amount := v_w.amount_tngn;

  -- Increment-form update: no read-then-write, no race.
  UPDATE public.users
  SET tngn_balance = COALESCE(tngn_balance, 0) + v_refund_amount
  WHERE id = v_w.user_id;

  UPDATE public.withdrawals
  SET status = 'rejected',
      gateway_response = jsonb_build_object('reason', p_reason),
      approved_at = now()
  WHERE id = p_withdrawal_id;

  INSERT INTO public.treasury_movements (
    user_id, type, gateway, direction, amount_ngn, reference, metadata
  ) VALUES (
    v_w.user_id, 'refund', NULL, 'out',
    COALESCE(v_w.spread_amount, 0) + COALESCE(v_w.flat_fee, 0),
    p_withdrawal_id,
    jsonb_build_object('source', 'withdrawal_reject', 'reason', p_reason)
  );

  RETURN jsonb_build_object(
    'status', 'rejected',
    'refunded_tngn', v_refund_amount,
    'user_id', v_w.user_id,
    'amount_tngn', v_w.amount_tngn
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_withdrawal(uuid, text) TO authenticated, service_role;
