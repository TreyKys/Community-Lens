-- Admins rank the Trending tab manually rather than it auto-sorting by
-- pool size. Lower trending_rank shows first; null sorts last (newly
-- flagged markets land at the bottom until an admin gives them a rank).

ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS trending_rank integer;

-- Same partial-index reasoning as idx_markets_is_trending — only the
-- small is_trending=true set is ever ordered by rank.
CREATE INDEX IF NOT EXISTS idx_markets_trending_rank
  ON public.markets (trending_rank)
  WHERE is_trending = true;
