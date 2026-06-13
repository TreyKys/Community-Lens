-- Add is_trending flag to markets so admin can curate what shows up in
-- the Trending tab — instead of "Trending" meaning "everything" (which
-- is confusing) it's now a small admin-picked set (e.g. Golden Boot,
-- Messi, group winners). Everything else lives under the new "New" tab.

ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS is_trending boolean NOT NULL DEFAULT false;

-- Partial index — we only ever query for is_trending=true; the false
-- rows (the vast majority) don't need the index entry.
CREATE INDEX IF NOT EXISTS idx_markets_is_trending
  ON public.markets (id DESC)
  WHERE is_trending = true;
