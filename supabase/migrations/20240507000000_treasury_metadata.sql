-- Add metadata column to treasury_log for manual credits & future annotations
ALTER TABLE public.treasury_log
  ADD COLUMN IF NOT EXISTS metadata jsonb;

-- Helpful indexes for the admin Credits panel
CREATE INDEX IF NOT EXISTS idx_treasury_log_type_created
  ON public.treasury_log (type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_treasury_log_user
  ON public.treasury_log (user_id);
