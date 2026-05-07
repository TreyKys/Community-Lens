-- Treasury ledger + dual-gateway support + new fee model.
--
-- Three concerns rolled into one migration because they share a table:
--
--   1. Add a unified `treasury_movements` ledger so we can answer
--      "what's our actual balance on Paystack vs Squad?" — separate from
--      the per-user wallet figure. Every NGN movement (deposits, withdrawals,
--      spread capture, rebates, bet rakes) writes a row here, tagged with
--      the gateway it touched.
--
--   2. Add `gateway` + admin-approval audit columns to `withdrawals` so
--      ops can route a payout through whichever gateway has the headroom.
--
--   3. Backfill `treasury_movements` from the existing tables
--      (paystack_transactions, squad_transactions, withdrawals, treasury_log)
--      so historical rows show up in the admin treasury dashboard.

-- ── Ledger table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.treasury_movements (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES public.users(id),
  type text NOT NULL,            -- deposit | withdrawal | spread | rebate | bet_rake | first_bet_insurance | manual_topup | refund
  gateway text,                  -- paystack | squad | null (internal)
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  amount_ngn numeric NOT NULL CHECK (amount_ngn >= 0),
  reference text,                -- transaction_ref / paystack ref / withdrawal_id
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_treasury_movements_gateway_direction
  ON public.treasury_movements (gateway, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_movements_user
  ON public.treasury_movements (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasury_movements_type
  ON public.treasury_movements (type, created_at DESC);

ALTER TABLE public.treasury_movements ENABLE ROW LEVEL SECURITY;
-- No public policies — read access is via service role only (admin API).

-- ── Withdrawals: gateway routing + admin audit ───────────────────────────
ALTER TABLE public.withdrawals
  ADD COLUMN IF NOT EXISTS gateway text,
  ADD COLUMN IF NOT EXISTS approved_by_admin uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS gateway_transfer_code text,
  ADD COLUMN IF NOT EXISTS gateway_response jsonb;

CREATE INDEX IF NOT EXISTS idx_withdrawals_status_created
  ON public.withdrawals (status, created_at DESC);

-- ── Backfill: paystack_transactions → treasury_movements ─────────────────
INSERT INTO public.treasury_movements (user_id, type, gateway, direction, amount_ngn, reference, metadata, created_at)
SELECT
  user_id, 'deposit', 'paystack', 'in',
  COALESCE(amount_ngn, 0),
  reference,
  jsonb_build_object('legacy', true, 'status', status, 'tngn_credited', tngn_credited),
  created_at
FROM public.paystack_transactions
WHERE status = 'completed'
ON CONFLICT DO NOTHING;

-- Spread capture rows for completed Paystack deposits
INSERT INTO public.treasury_movements (user_id, type, gateway, direction, amount_ngn, reference, metadata, created_at)
SELECT
  user_id, 'spread', 'paystack', 'in',
  COALESCE(spread_captured, 0),
  reference,
  jsonb_build_object('legacy', true),
  created_at
FROM public.paystack_transactions
WHERE status = 'completed' AND COALESCE(spread_captured, 0) > 0
ON CONFLICT DO NOTHING;

-- ── Backfill: squad_transactions → treasury_movements ────────────────────
INSERT INTO public.treasury_movements (user_id, type, gateway, direction, amount_ngn, reference, metadata, created_at)
SELECT
  user_id, 'deposit', 'squad', 'in',
  COALESCE(amount_ngn, 0),
  transaction_ref,
  jsonb_build_object('legacy', true, 'status', status, 'tngn_credited', tngn_credited),
  created_at
FROM public.squad_transactions
WHERE status = 'completed'
ON CONFLICT DO NOTHING;

INSERT INTO public.treasury_movements (user_id, type, gateway, direction, amount_ngn, reference, metadata, created_at)
SELECT
  user_id, 'spread', 'squad', 'in',
  COALESCE(spread_captured, 0),
  transaction_ref,
  jsonb_build_object('legacy', true),
  created_at
FROM public.squad_transactions
WHERE status = 'completed' AND COALESCE(spread_captured, 0) > 0
ON CONFLICT DO NOTHING;

-- ── Backfill: withdrawals → treasury_movements (best-effort, gateway unknown for legacy rows) ──
INSERT INTO public.treasury_movements (user_id, type, gateway, direction, amount_ngn, reference, metadata, created_at)
SELECT
  user_id, 'withdrawal', NULL, 'out',
  COALESCE(naira_to_send, 0),
  id::text,
  jsonb_build_object('legacy', true, 'status', status, 'amount_tngn', amount_tngn),
  created_at
FROM public.withdrawals
WHERE status NOT IN ('failed', 'rejected', 'cancelled') AND COALESCE(naira_to_send, 0) > 0
ON CONFLICT DO NOTHING;
