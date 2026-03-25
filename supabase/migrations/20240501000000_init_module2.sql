-- Create the users table to track the 1% frictional deposit bonus and profile info
CREATE TABLE IF NOT EXISTS public.users (
  walletAddress text PRIMARY KEY,
  bonus_balance numeric DEFAULT 0,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Allow public read access to users
CREATE POLICY "Public profiles are viewable by everyone." ON public.users
  FOR SELECT USING (true);

-- Create the market_snapshots table to record hourly Pool Volume Ratios for charting
CREATE TABLE IF NOT EXISTS public.market_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id bigint NOT NULL,
  total_pool numeric NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.market_snapshots ENABLE ROW LEVEL SECURITY;

-- Allow public read access to market snapshots
CREATE POLICY "Public snapshots are viewable by everyone." ON public.market_snapshots
  FOR SELECT USING (true);

-- Create index for faster querying by market ID and timestamp
CREATE INDEX IF NOT EXISTS market_snapshots_market_id_created_at_idx
ON public.market_snapshots (market_id, created_at DESC);

-- Create a table for market metadata (like custom titles or the isLive status)
CREATE TABLE IF NOT EXISTS public.market_metadata (
  market_id bigint PRIMARY KEY,
  is_live boolean DEFAULT false,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security
ALTER TABLE public.market_metadata ENABLE ROW LEVEL SECURITY;

-- Allow public read access to market metadata
CREATE POLICY "Public metadata is viewable by everyone." ON public.market_metadata
  FOR SELECT USING (true);

-- Service role (via backend/CRON) natively bypasses RLS, so no INSERT/UPDATE policies are needed for public anon keys.