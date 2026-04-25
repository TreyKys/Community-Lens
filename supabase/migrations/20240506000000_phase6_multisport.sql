-- Phase 6: Multi-sport support + market creation fields

-- Add sport column to markets table
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS sport text DEFAULT 'football',
  ADD COLUMN IF NOT EXISTS league_code text,         -- e.g. PL, CL, NBA, ATP
  ADD COLUMN IF NOT EXISTS home_team text,           -- for display in UI
  ADD COLUMN IF NOT EXISTS away_team text,
  ADD COLUMN IF NOT EXISTS ai_generated boolean DEFAULT false;

-- Index for oracle worker sport routing
CREATE INDEX IF NOT EXISTS markets_sport_status_idx ON public.markets (sport, status);
CREATE INDEX IF NOT EXISTS markets_fixture_id_idx ON public.markets (fixture_id) WHERE fixture_id IS NOT NULL;

-- AI market generation review queue
-- Markets sit here until TreyKy approves them
CREATE TABLE IF NOT EXISTS public.market_drafts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  question text NOT NULL,
  category text NOT NULL,
  sport text,
  league_code text,
  options jsonb NOT NULL,
  closes_at timestamptz NOT NULL,
  fixture_id bigint,
  home_team text,
  away_team text,
  parent_draft_id uuid,
  status text DEFAULT 'pending_review', -- pending_review | approved | rejected
  rejection_reason text,
  ai_model text,
  source_doc_name text,
  created_at timestamptz DEFAULT now(),
  reviewed_at timestamptz
);

ALTER TABLE public.market_drafts ENABLE ROW LEVEL SECURITY;
-- Only admin (service role) can touch drafts

-- API-Sports provider tracking
CREATE TABLE IF NOT EXISTS public.api_sports_processed (
  fixture_id bigint PRIMARY KEY,
  sport text NOT NULL,
  processed_at timestamptz DEFAULT now()
);

NOTIFY pgrst, 'reload schema';
