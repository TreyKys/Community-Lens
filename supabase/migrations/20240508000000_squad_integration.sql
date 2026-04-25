-- Squad by HabariPay: per-user virtual NUBAN + inbound transactions
--
-- Squad differs from Paystack by issuing each user a permanent NUBAN.
-- When a user funds their account by bank transfer, Squad fires a webhook
-- to /api/webhooks/squad which credits tngn_balance + bonus_balance, mirroring
-- the existing Paystack flow.

CREATE TABLE IF NOT EXISTS public.squad_virtual_accounts (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  customer_identifier text NOT NULL,
  account_number text NOT NULL,
  account_name text NOT NULL,
  bank_code text,
  bank_name text,
  raw_response jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_squad_virtual_accounts_account_number
  ON public.squad_virtual_accounts (account_number);

ALTER TABLE public.squad_virtual_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own squad account" ON public.squad_virtual_accounts
  FOR SELECT USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.squad_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_ref text UNIQUE NOT NULL,
  user_id uuid REFERENCES public.users(id),
  amount_ngn numeric NOT NULL,
  tngn_credited numeric,
  spread_captured numeric,
  status text DEFAULT 'pending',
  raw_payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_squad_transactions_user_created
  ON public.squad_transactions (user_id, created_at DESC);

ALTER TABLE public.squad_transactions ENABLE ROW LEVEL SECURITY;

-- Idempotency hardening: paystack_transactions.reference is already UNIQUE NOT NULL,
-- but explicitly add an index in case future migrations alter the constraint.
CREATE INDEX IF NOT EXISTS idx_paystack_transactions_reference
  ON public.paystack_transactions (reference);
