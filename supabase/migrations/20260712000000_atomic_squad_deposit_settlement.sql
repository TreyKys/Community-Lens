-- Atomic, idempotent, recovery-safe Squad deposit crediting.
--
-- The old flow credited a deposit in THREE separate, non-atomic awaited
-- steps in both /api/squad/verify and /api/webhooks/squad:
--   1. CAS the row status → 'crediting'
--   2. call credit_user (moves the money)
--   3. write status → 'completed', then insert the treasury ledger rows
--
-- A transient failure of step 2 (a Supabase timeout — a natural ~1/10
-- flake) stranded the row in 'crediting'/'failed_balance_update', which
-- the verify endpoint's CAS could never re-claim (it only matched
-- 'pending'/'awaiting_payment') — so it then FALSELY reported
-- {status:'completed'} to the user while the wallet was never credited.
-- A crash between steps 2 and 3 could also leave a row 'crediting' with
-- the money already moved, and the webhook's unguarded reset-to-'pending'
-- could re-claim and DOUBLE credit. This is the root cause of "debited
-- but not credited" (and its rarer double-credit twin).
--
-- Fix: one function does the whole credit atomically inside a single
-- transaction, under a row lock, using the deposit ledger row in
-- treasury_movements as the definitive "was this money moved?" anchor.
-- Because credit + ledger insert + status flip all commit together,
-- a row is only ever "not credited" (no ledger row) or "credited"
-- (ledger row present) — the ambiguous 'crediting' half-state can never
-- be produced going forward.
--
-- The CALLER is responsible for confirming with Squad that the payment
-- actually succeeded before calling this (verify/webhook/cron all do a
-- server-to-server verify or only fire on success events). This
-- function assumes the payment is good and only handles the money move.

CREATE OR REPLACE FUNCTION public.settle_squad_deposit(
  p_transaction_ref text,
  p_amount_ngn       numeric   -- confirmed gross deposit in naira
)
RETURNS TABLE (
  outcome         text,        -- 'credited' | 'already_credited' | 'needs_review' | 'not_found'
  user_id         uuid,
  amount_ngn      numeric,
  tngn_credited   numeric,
  spread_captured numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
-- The directive above MUST be the first line of the function body. The
-- RETURNS TABLE output columns (amount_ngn/tngn_credited/spread_captured/
-- user_id) share names with squad_transactions columns; forcing bare
-- references inside queries to mean the COLUMN removes any dependence on
-- the server's default variable_conflict setting. (All our reads are
-- v_row.*/v_*-qualified anyway; this is belt-and-suspenders.)
DECLARE
  c_spread_pct constant numeric := 0.01;   -- MUST match CONVERSION_SPREAD in the routes
  v_row     record;
  v_user    uuid;
  v_amount  numeric;
  v_spread  numeric;
  v_credit  numeric;
  v_ledger_exists boolean;
BEGIN
  -- Lock the deposit row. This serializes every concurrent caller for
  -- this ref (verify vs webhook vs reconcile cron) — the second one
  -- blocks here, then sees the committed 'completed'/ledger state and
  -- no-ops. This lock IS the concurrency guarantee.
  SELECT * INTO v_row
  FROM public.squad_transactions
  WHERE transaction_ref = p_transaction_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, 0::numeric, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  v_user   := v_row.user_id;
  -- Amount source of truth is whatever the confirmed-payment caller
  -- passes: verify passes the row's amount_ngn (set at initiate);
  -- webhook/cron pass the gateway-confirmed amount. Spread math is the
  -- exact same arithmetic the routes did (amount*0.01 / amount*0.99),
  -- unrounded so there is zero drift versus the previous behaviour.
  v_amount := p_amount_ngn;
  v_spread := v_amount * c_spread_pct;
  v_credit := v_amount - v_spread;

  -- Fast path: already fully settled.
  IF v_row.status = 'completed' THEN
    RETURN QUERY SELECT 'already_credited'::text, v_user,
      COALESCE(v_row.amount_ngn, v_amount),
      COALESCE(v_row.tngn_credited, v_credit),
      COALESCE(v_row.spread_captured, v_spread);
    RETURN;
  END IF;

  -- Definitive idempotency anchor: a deposit movement for this ref means
  -- the money was already moved (the row just never got marked done).
  -- Heal the status, never re-credit.
  SELECT EXISTS (
    SELECT 1 FROM public.treasury_movements
    WHERE reference = p_transaction_ref
      AND type = 'deposit'
      AND gateway = 'squad'
  ) INTO v_ledger_exists;

  IF v_ledger_exists THEN
    -- Qualify the RHS with v_row.* — the RETURNS TABLE output columns
    -- (amount_ngn/tngn_credited/spread_captured) are in scope as local
    -- variables here, so a bare column name would be ambiguous.
    UPDATE public.squad_transactions
    SET status = 'completed',
        amount_ngn = COALESCE(v_row.amount_ngn, v_amount),
        tngn_credited = COALESCE(v_row.tngn_credited, v_credit),
        spread_captured = COALESCE(v_row.spread_captured, v_spread)
    WHERE transaction_ref = p_transaction_ref;
    RETURN QUERY SELECT 'already_credited'::text, v_user,
      COALESCE(v_row.amount_ngn, v_amount),
      COALESCE(v_row.tngn_credited, v_credit),
      COALESCE(v_row.spread_captured, v_spread);
    RETURN;
  END IF;

  -- 'crediting' with NO ledger row is the ONE genuinely ambiguous state
  -- the OLD non-atomic flow could leave: the money may or may not have
  -- moved before a crash. Refuse to auto-credit — surface for manual
  -- admin review rather than risk a double credit. (Going forward this
  -- state can never occur, since credit + ledger + status now commit
  -- together, so this only ever applies to the pre-migration backlog.)
  IF v_row.status = 'crediting' THEN
    RETURN QUERY SELECT 'needs_review'::text, v_user, v_amount, v_credit, v_spread;
    RETURN;
  END IF;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'settle_squad_deposit: transaction % has no user_id', p_transaction_ref
      USING ERRCODE = 'P0002';
  END IF;

  -- Provably-uncredited state (awaiting_payment / pending /
  -- failed_balance_update / failed_*). Do the whole credit atomically.
  -- credit_user is itself row-locked; if it raises, the whole function
  -- rolls back and nothing is half-done.
  PERFORM public.credit_user(v_user, v_credit, 0);

  -- The ledger insert IS the idempotency record, written in the SAME
  -- transaction as the credit above.
  INSERT INTO public.treasury_movements (user_id, type, gateway, direction, amount_ngn, reference)
  VALUES
    (v_user, 'deposit', 'squad', 'in', v_amount, p_transaction_ref),
    (v_user, 'spread',  'squad', 'in', v_spread, p_transaction_ref);

  UPDATE public.squad_transactions
  SET status = 'completed',
      amount_ngn = v_amount,
      tngn_credited = v_credit,
      spread_captured = v_spread
  WHERE transaction_ref = p_transaction_ref;

  RETURN QUERY SELECT 'credited'::text, v_user, v_amount, v_credit, v_spread;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_squad_deposit(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_squad_deposit(text, numeric) TO service_role;

COMMENT ON FUNCTION public.settle_squad_deposit IS
  'Atomic, idempotent, recovery-safe Squad deposit crediting. Locks the squad_transactions row, uses the treasury_movements deposit ledger row as the definitive already-credited anchor, credits + ledgers + completes in one transaction. Callers must have confirmed the payment succeeded with Squad first. Returns outcome credited|already_credited|needs_review|not_found. See migration 20260712000000.';

-- Speeds the ledger idempotency lookup and the reconciliation cron's
-- stuck-row scan.
CREATE INDEX IF NOT EXISTS idx_treasury_movements_reference
  ON public.treasury_movements (reference);
CREATE INDEX IF NOT EXISTS idx_squad_transactions_status_created
  ON public.squad_transactions (status, created_at);

NOTIFY pgrst, 'reload schema';
