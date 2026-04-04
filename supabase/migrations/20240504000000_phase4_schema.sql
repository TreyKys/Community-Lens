-- Phase 4 schema additions
-- Add columns to users table
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS username text UNIQUE,
  ADD COLUMN IF NOT EXISTS avatar_id integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profile_complete boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS free_bet_credits numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS dob date;

-- Add fixture_id and on_chain_market_id to markets if not already there
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS fixture_id bigint;

-- Add first_bet_refunded flag to user_bets
ALTER TABLE public.user_bets
  ADD COLUMN IF NOT EXISTS is_first_bet_refunded boolean DEFAULT false;

-- Notifications table for real-time user alerts
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type text NOT NULL, -- 'first_bet_refund' | 'bet_won' | 'bet_lost' | 'deposit' | 'withdrawal'
  message text NOT NULL,
  amount numeric,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own notifications" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id);

-- Index for fast username lookup
CREATE INDEX IF NOT EXISTS users_username_idx ON public.users (username);

-- Index for notifications
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON public.notifications (user_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
