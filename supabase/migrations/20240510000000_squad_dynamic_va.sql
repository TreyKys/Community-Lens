-- Squad pivot: from static (BVN-required) to dynamic (per-transaction) virtual accounts.
--
-- Dynamic VAs are minted per deposit attempt with a 30-minute expiry. Each row in
-- squad_transactions now needs to carry the amount the user committed to and when
-- the temporary NUBAN expires, so the webhook can validate the credit and the UI
-- can show a live countdown.
--
-- squad_virtual_accounts is left in place but will be dormant; we may revisit
-- static accounts later as a higher-tier feature for KYC-verified users.

ALTER TABLE public.squad_transactions
  ADD COLUMN IF NOT EXISTS expected_amount numeric,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_squad_transactions_awaiting
  ON public.squad_transactions (transaction_ref)
  WHERE status = 'awaiting_payment';
