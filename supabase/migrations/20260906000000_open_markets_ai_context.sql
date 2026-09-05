-- "More about this market" — a short, neutral background panel on the
-- trading page, generated once per market and cached rather than regenerated
-- on every page view.
--
-- WHAT THIS IS NOT: a prediction, an opinion on the outcome, or financial
-- advice. It is general background on the SUBJECT of the question ("what
-- moves fuel prices", not "will they go up"). The prompt in
-- lib/openMarketContext.ts enforces that boundary; this column just holds
-- whatever it produced, plus when, so the page can serve it instantly on
-- every view after the first and skip the Gemini call entirely until it goes
-- stale.
ALTER TABLE public.open_markets
  ADD COLUMN IF NOT EXISTS ai_context jsonb,
  ADD COLUMN IF NOT EXISTS ai_context_generated_at timestamptz;

COMMENT ON COLUMN public.open_markets.ai_context IS
  'Array of {title, body} items — AI-generated general background on the market''s subject. Neutral by construction (see lib/openMarketContext.ts); never a prediction or house opinion on the outcome.';
COMMENT ON COLUMN public.open_markets.ai_context_generated_at IS
  'When ai_context was last generated. NULL means never generated. Regenerated when older than the freshness window in the /context route, not on a fixed schedule.';

NOTIFY pgrst, 'reload schema';
