-- ============================================================
-- Phase 3 Schema Migration
-- Drops the old walletAddress-primary-key users table and
-- rebuilds with Supabase auth UUID as primary key.
-- Adds all tables required for the new off-chain betting model.
-- ============================================================

-- 1. Drop old users table (data loss acceptable — testnet only)
DROP TABLE IF EXISTS public.users CASCADE;

-- 2. Rebuild users table tied to Supabase auth
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  phone text,
  wallet_address text,                    -- derived from KMS, stored for reference
  tngn_balance numeric DEFAULT 0,         -- real withdrawable balance
  bonus_balance numeric DEFAULT 0,        -- non-withdrawable betting credit
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile" ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING (auth.uid() = id);

-- 3. Markets table (source of truth for all markets)
CREATE TABLE IF NOT EXISTS public.markets (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  question text NOT NULL,
  category text NOT NULL DEFAULT 'sports',   -- sports | politics | economics | entertainment | finance
  options jsonb NOT NULL,                    -- array of option strings
  closes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',       -- open | locked | resolved | voided
  merkle_root text,                          -- set at lock time
  total_pool numeric DEFAULT 0,
  resolved_outcome integer,                  -- winning option index
  parent_market_id bigint,                   -- for sub-markets
  on_chain_market_id bigint,                 -- links to TruthMarket.sol market ID
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Markets viewable by everyone" ON public.markets
  FOR SELECT USING (true);

-- 4. User bets
CREATE TABLE IF NOT EXISTS public.user_bets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  market_id bigint NOT NULL REFERENCES public.markets(id),
  outcome_index integer NOT NULL,
  stake_tngn numeric NOT NULL,              -- what user sent
  net_stake_tngn numeric NOT NULL,          -- after Entry Rake
  entry_rake_tngn numeric NOT NULL,
  is_jackpot_eligible boolean DEFAULT false,
  status text DEFAULT 'active',             -- active | won | lost | refunded
  payout_tngn numeric,
  placed_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_bets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own bets" ON public.user_bets
  FOR SELECT USING (auth.uid() = user_id);

-- 5. Merkle commit log
CREATE TABLE IF NOT EXISTS public.merkle_commits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id bigint NOT NULL REFERENCES public.markets(id),
  root_hash text NOT NULL,
  bet_count integer DEFAULT 0,
  committed_at timestamptz DEFAULT now(),
  polygon_tx_hash text                      -- null until on-chain tx confirms
);

ALTER TABLE public.merkle_commits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Merkle commits viewable by everyone" ON public.merkle_commits
  FOR SELECT USING (true);

-- 6. Paystack transactions (idempotency + audit log)
CREATE TABLE IF NOT EXISTS public.paystack_transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  reference text UNIQUE NOT NULL,
  user_id uuid REFERENCES public.users(id),
  amount_ngn numeric NOT NULL,
  tngn_credited numeric,
  spread_captured numeric,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.paystack_transactions ENABLE ROW LEVEL SECURITY;

-- 7. Withdrawals
CREATE TABLE IF NOT EXISTS public.withdrawals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  amount_tngn numeric NOT NULL,
  spread_amount numeric,
  flat_fee numeric,
  naira_to_send numeric,
  bank_code text,
  account_number text,
  account_name text,
  status text DEFAULT 'pending_paystack',
  requires_admin_approval boolean DEFAULT false,
  admin_note text,
  paystack_transfer_code text,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own withdrawals" ON public.withdrawals
  FOR SELECT USING (auth.uid() = user_id);

-- 8. Treasury log (Entry Rake + Resolution Rake tracking)
CREATE TABLE IF NOT EXISTS public.treasury_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL,                       -- entry_rake | resolution_rake | spread
  amount_tngn numeric NOT NULL,
  bet_id uuid,
  market_id bigint,
  user_id uuid,
  created_at timestamptz DEFAULT now()
);

-- 9. Heartbeat log
CREATE TABLE IF NOT EXISTS public.heartbeat_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fired_at timestamptz DEFAULT now(),
  polygon_tx_hash text
);

-- 10. Error log (for critical failures that need manual review)
CREATE TABLE IF NOT EXISTS public.error_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text,
  bet_id uuid,
  user_id uuid,
  amount numeric,
  created_at timestamptz DEFAULT now()
);

-- Preserve existing market_snapshots and market_metadata tables
-- (already created in earlier migrations — no changes needed)

NOTIFY pgrst, 'reload schema';
