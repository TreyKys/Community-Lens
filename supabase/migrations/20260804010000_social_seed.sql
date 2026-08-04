-- ================================================================
-- Starter data for the social pipeline.
-- ================================================================
-- Two things the system cannot run without: something to watch, and
-- something to fall back on.
--
-- The target list is deliberately SIX accounts. Each billable poll of
-- one account costs $0.025 (X's 5-result floor on the timeline
-- endpoint), so at two scans a day six targets is roughly $4.50/month
-- against a ~$6.50 cap. A seventh is a budget decision, not a config
-- tweak — see app/api/social/scan/route.ts.
--
-- The handles below are PLACEHOLDERS chosen as category examples. Swap
-- them for accounts you actually want to be seen replying under before
-- enabling the scan cron; who you reply to IS the targeting.
-- ================================================================

INSERT INTO public.social_targets (handle, label, poll_weight, active)
VALUES
  -- poll_weight 1 = checked every scan. Reserve it for accounts whose
  -- posts reliably start a conversation worth joining.
  ('brfootball',     'global football news — high volume, fast takes',  1, false),
  ('OptaJoe',        'football stats — good for a numbers counterpoint', 1, false),

  -- poll_weight 2 = every other scan. Steady but less time-critical.
  ('NGRSuperEagles', 'Nigerian national team',                          2, false),
  ('naijafm',        'Nigerian pop culture and entertainment',          2, false),

  -- poll_weight 3 = sampled. The long tail.
  ('NGRPresident',   'Nigerian politics — handle with care',            3, false),
  ('nairametrics',   'Nigerian economy and markets',                    3, false)
ON CONFLICT (handle) DO NOTHING;

-- NOTE: every row is seeded active = false ON PURPOSE.
--
-- The scan route reads from X, and every read bills. Seeding these live
-- would mean the first cron tick after deploy spends money against a
-- target list nobody has reviewed. Edit the handles, then enable:
--
--   UPDATE public.social_targets SET active = true WHERE handle IN (...);


-- Evergreen fallbacks -------------------------------------------------
-- The floor, not the engine. These publish only when a planner run
-- cannot find enough live markets to fill the day's slots — a dead
-- fixture day, or an outage in the sports feeds.
--
-- They are scheduled_at NULL until the planner claims one, which is why
-- social_posts.scheduled_at is nullable for exactly this kind.
--
-- Every one is link-free (the DB CHECK enforces it) and none makes a
-- return promise, because these are the posts most likely to go out
-- unattended.
INSERT INTO public.social_posts (channel, kind, body, scheduled_at, priority, status)
VALUES
  ('x', 'evergreen',
   'A bookmaker sets a price and hopes you take it. A market sets a price because someone on the other side disagreed with you. Those are not the same product.',
   NULL, 500, 'queued'),

  ('x', 'evergreen',
   'The interesting number is never the favourite. It is how fast the crowd moved after the team sheet dropped.',
   NULL, 500, 'queued'),

  ('x', 'evergreen',
   'Nobody remembers the pundit who said "it could go either way". Markets do not have that option — they have to put a number on it.',
   NULL, 500, 'queued'),

  ('x', 'evergreen',
   'Odds are just an opinion with money behind it. That is the whole idea.',
   NULL, 500, 'queued'),

  ('x', 'evergreen',
   'Everyone in the group chat had Arsenal winning the league in October. The receipts are the point.',
   NULL, 500, 'queued'),

  ('x', 'evergreen',
   'If you are right and the crowd is wrong, that is worth something. If you are right and everyone agrees, it is worth almost nothing. Prices carry that difference.',
   NULL, 500, 'queued')
ON CONFLICT DO NOTHING;
