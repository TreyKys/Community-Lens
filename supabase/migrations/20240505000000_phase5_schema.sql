-- Phase 5 schema additions

-- Add missing columns to markets
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS is_jackpot_eligible boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolution_attempts integer DEFAULT 0;

-- Add jackpot pool tracking
CREATE TABLE IF NOT EXISTS public.jackpot_pool (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  amount numeric DEFAULT 0,
  status text DEFAULT 'active', -- active | paid_out
  week_start timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Add resolution_attempts and fixture_id if not present
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS resolution_attempts integer DEFAULT 0;

-- Notifications need to support admin alerts (null user_id)
ALTER TABLE public.notifications
  ALTER COLUMN user_id DROP NOT NULL;

-- Create index on notifications type for admin alerts
CREATE INDEX IF NOT EXISTS notifications_type_idx ON public.notifications (type);

-- Index on markets category + status for fast filtering
CREATE INDEX IF NOT EXISTS markets_category_status_idx ON public.markets (category, status);
CREATE INDEX IF NOT EXISTS markets_closes_at_status_idx ON public.markets (closes_at, status);

NOTIFY pgrst, 'reload schema';
