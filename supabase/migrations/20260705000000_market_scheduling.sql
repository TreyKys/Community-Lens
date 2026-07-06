-- Scheduled markets: an admin can now queue a market to open
-- automatically at a future time instead of the instant it's created
-- (status = 'scheduled' until opens_at arrives, then a cron flips it
-- to 'open' — see /api/markets/open-scheduled).
--
-- published_at tracks when a market actually became publicly visible
-- (immediately at creation for the normal path, or later when the
-- scheduled-open cron fires). The New/Trending feed sorts by this
-- instead of id/created_at so a market authored today but scheduled to
-- open next week still lands at the top of "New" the moment it opens,
-- rather than being buried under markets created in the interim.

ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS opens_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

-- Backfill: every existing row went live the instant it was created.
UPDATE public.markets SET published_at = created_at WHERE published_at IS NULL;

-- Cron sweep query: status = 'scheduled' AND opens_at <= now().
CREATE INDEX IF NOT EXISTS markets_scheduled_opens_at_idx
  ON public.markets (opens_at)
  WHERE status = 'scheduled';

-- New/Trending default ordering.
CREATE INDEX IF NOT EXISTS markets_status_published_at_idx
  ON public.markets (status, published_at DESC);
