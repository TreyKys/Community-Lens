-- Saved market "shapes" for one-click reuse. Distinct from cloning a past
-- market: a template is explicitly named and kept around indefinitely,
-- so a recurring shape (e.g. "EPL 1X2", "BTC Daily Close") doesn't get
-- buried or hard to find once the market it was cloned from resolves.
--
-- Mirrors exactly what /admin's "Clone & Edit" already copies from a
-- market row (see applyClone in admin/page.tsx) so quick-create can
-- reuse the same prefill path. is_locked_odds defaults TRUE here —
-- every market created going forward is expected to carry locked odds,
-- unlike the markets table's own column (which defaults false to
-- preserve pre-existing parimutuel rows untouched).

CREATE TABLE IF NOT EXISTS public.market_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  question text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'sports',
  options jsonb NOT NULL DEFAULT '["Home Win", "Draw", "Away Win"]'::jsonb,
  sport text,
  home_team text,
  away_team text,
  league_code text,
  description text,
  -- Convenience only: quick-create prefills "closes at" this many hours
  -- from the moment it's used. NULL leaves it blank for the admin to set.
  default_closes_in_hours integer,
  is_locked_odds boolean NOT NULL DEFAULT true,
  seed_pool jsonb NOT NULL DEFAULT '{}'::jsonb,
  seed_probability numeric CHECK (seed_probability IS NULL OR (seed_probability > 0 AND seed_probability < 1)),
  vig_pct numeric CHECK (vig_pct IS NULL OR (vig_pct >= 0.04 AND vig_pct <= 0.15)),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE INDEX IF NOT EXISTS market_templates_name_idx ON public.market_templates (name);

-- Admin tooling only — same access model as house_reserve/market_liability:
-- no direct client read/write, everything goes through the service-role
-- API routes which already gate on isAdminRequest().
ALTER TABLE public.market_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_templates_service_only ON public.market_templates;
CREATE POLICY market_templates_service_only ON public.market_templates
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.market_templates IS
  'Saved, named market "shapes" (question/category/options/locked-odds config) for one-click reuse from the admin Create tab — separate from cloning a specific past market, so a recurring shape stays easy to find after the market it originated from resolves.';
