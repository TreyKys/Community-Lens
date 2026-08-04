-- ================================================================
-- Social pipeline: the X (Twitter) publishing + reply-brief system.
-- ================================================================
-- Context that shaped this schema:
--
-- X killed its tiered pricing in Feb 2026. There is no free tier any
-- more; new developers are metered pay-per-use:
--
--     post created ................... $0.015
--     post created CONTAINING A LINK .. $0.200   (13.3x)
--     post read ...................... $0.005
--
-- Two consequences are baked into these tables:
--
--  1. `social_spend` is a hard budget ledger. Every metered X call
--     debits it BEFORE the call goes out, and the publisher refuses to
--     act once month-to-date crosses the cap. X's own spend cap is the
--     backstop; this is the thing that stops us reaching it. A runaway
--     cron on a metered API is how you wake up to a $400 bill.
--
--  2. `social_posts.body` is validated link-free at write time. Links
--     never go out through the API — they go out in a manual reply from
--     the phone, which costs nothing and is also what the timeline
--     rewards. See lib/social/x.ts.
--
-- Everything here is service-role only. There is no client-facing
-- surface: RLS denies anon and authenticated outright, matching the
-- lockdown posture from 20240613000000.
-- ================================================================


-- 1. OUTBOUND POST QUEUE -----------------------------------------
-- One row per intended post. Rows are generated (from live markets and
-- fixtures), not authored, so `source_market_id` is the usual origin.
-- Hand-written evergreen fallbacks have a null source and live at a
-- low priority so they only fire on dead fixture days.
CREATE TABLE IF NOT EXISTS public.social_posts (
  id                bigserial PRIMARY KEY,
  channel           text NOT NULL DEFAULT 'x',        -- x | ig (ig lands next)
  kind              text NOT NULL,                    -- opening_line | movement | settlement | evergreen | manual
  body              text NOT NULL,
  media_url         text,                             -- absolute URL to an /api/*-card route
  source_market_id  varchar(255) REFERENCES public.markets(id) ON DELETE SET NULL,

  -- Nullable so the evergreen pool can sit unscheduled until a planner
  -- run needs a filler for a dead fixture day. Everything else must
  -- carry a time — enforced below.
  scheduled_at      timestamptz,
  priority          integer NOT NULL DEFAULT 100,     -- lower wins when several are due
  status            text NOT NULL DEFAULT 'queued',   -- queued | publishing | published | failed | skipped | cancelled

  -- Populated on success so we can build the permalink and, later,
  -- attribute signups back to a specific post.
  provider_post_id  text,
  published_at      timestamptz,

  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_posts_channel_chk CHECK (channel IN ('x', 'ig')),
  CONSTRAINT social_posts_status_chk CHECK (
    status IN ('queued', 'publishing', 'published', 'failed', 'skipped', 'cancelled')
  ),
  -- X's own limit is 280 chars. We stop well short so an appended
  -- cashtag or emoji can never push a queued post over at publish time.
  CONSTRAINT social_posts_body_len_chk CHECK (char_length(body) BETWEEN 1 AND 270),

  -- THE MONEY CONSTRAINT. A post body containing a URL costs 13.3x at
  -- the API. The composer strips links, but a hand-inserted row would
  -- bypass that, so the invariant lives in the database where nothing
  -- can route around it. Links go out in a manual reply instead.
  CONSTRAINT social_posts_no_link_chk CHECK (
    body !~* '(https?://|www\.|\y[a-z0-9-]+\.(com|ng|io|co|org|net|gg|tv|app|xyz)\y)'
  ),

  -- Only evergreen filler may sit without a time. Anything derived from
  -- a market is time-sensitive by construction, and an unscheduled one
  -- would silently never publish.
  CONSTRAINT social_posts_scheduled_chk CHECK (
    scheduled_at IS NOT NULL OR kind = 'evergreen'
  )
);

-- The publisher's hot query: "what is due right now, best first".
CREATE INDEX IF NOT EXISTS idx_social_posts_due
  ON public.social_posts (scheduled_at, priority)
  WHERE status = 'queued';

-- Dedupe guard. One market must not produce two opening-line posts
-- because the planner ran twice — GitHub Actions retries, and
-- `concurrency` groups do not make a job exactly-once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_posts_market_kind
  ON public.social_posts (source_market_id, kind, channel)
  WHERE source_market_id IS NOT NULL AND status <> 'cancelled';


-- 2. MONITORED ACCOUNTS ------------------------------------------
-- The reply surface. Each row is an X account we read on a schedule so
-- Gemini can draft a reply to their newest post. Reads are metered, so
-- `poll_weight` lets a handful of high-signal accounts get checked on
-- every scan while the long tail is sampled.
CREATE TABLE IF NOT EXISTS public.social_targets (
  id             bigserial PRIMARY KEY,
  handle         text NOT NULL,                       -- without the @
  provider_user_id text,                              -- cached; resolving costs a read
  label          text,                                -- 'football analyst', 'afrobeats', ...
  poll_weight    integer NOT NULL DEFAULT 1,          -- 1 = every scan, 2 = every other, ...
  active         boolean NOT NULL DEFAULT true,
  last_seen_post_id text,                             -- newest post already drafted against
  last_scanned_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_targets_handle_uq UNIQUE (handle),
  CONSTRAINT social_targets_handle_chk CHECK (handle ~ '^[A-Za-z0-9_]{1,15}$')
);

CREATE INDEX IF NOT EXISTS idx_social_targets_active
  ON public.social_targets (poll_weight, last_scanned_at NULLS FIRST)
  WHERE active;


-- 3. DRAFTED REPLIES ---------------------------------------------
-- A scan produces these; the Telegram bot presents them; a human
-- approves. Default execution is MANUAL — the operator copies the text
-- and pastes it in the native X app. That costs $0 and carries better
-- distribution than an API post. Rows still get a terminal status so
-- the funnel is measurable either way.
CREATE TABLE IF NOT EXISTS public.social_replies (
  id                 bigserial PRIMARY KEY,
  target_id          bigint REFERENCES public.social_targets(id) ON DELETE SET NULL,

  source_post_id     text NOT NULL,                   -- the X post we are replying to
  source_author      text NOT NULL,
  source_text        text NOT NULL,                   -- snapshot; we do not re-read (metered)

  draft_body         text NOT NULL,
  edited_body        text,                            -- if the operator rewrote it

  status             text NOT NULL DEFAULT 'drafted', -- drafted | sent_to_review | approved | posted | rejected | expired
  approved_at        timestamptz,
  posted_via         text,                            -- 'manual' | 'api'
  provider_post_id   text,

  telegram_message_id bigint,                         -- so we can edit the card in place

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_replies_status_chk CHECK (
    status IN ('drafted', 'sent_to_review', 'approved', 'posted', 'rejected', 'expired')
  ),
  CONSTRAINT social_replies_via_chk CHECK (posted_via IS NULL OR posted_via IN ('manual', 'api')),
  CONSTRAINT social_replies_len_chk CHECK (char_length(draft_body) BETWEEN 1 AND 270),
  -- Identical pattern to social_posts, bare domains included. Two
  -- reasons it must be the strict version here as well: under
  -- SOCIAL_REPLY_MODE=api a link still bills 13.3x, and a bare
  -- "opinionsng.com" in someone else's mentions is precisely the
  -- self-promotion that gets a reply ratioed. lib/social/reply.ts
  -- rejects the same thing in code; this is the backstop.
  CONSTRAINT social_replies_no_link_chk CHECK (
    draft_body !~* '(https?://|www\.|\y[a-z0-9-]+\.(com|ng|io|co|org|net|gg|tv|app|xyz)\y)'
  )
);

-- One draft per source post. A rescan that re-sees the same post must
-- not buzz the phone twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_replies_source
  ON public.social_replies (source_post_id);

CREATE INDEX IF NOT EXISTS idx_social_replies_pending
  ON public.social_replies (created_at)
  WHERE status IN ('drafted', 'sent_to_review');


-- 4. SPEND LEDGER — THE SAFETY VALVE -----------------------------
-- Append-only. One row per metered X API call, written BEFORE the call
-- so a crash mid-request fails closed (we over-count rather than
-- under-count). `usd_cost` is what X's published rate card says the
-- call costs; it is our estimate, not a billing statement — reconcile
-- against the developer portal monthly.
CREATE TABLE IF NOT EXISTS public.social_spend (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  provider     text NOT NULL DEFAULT 'x',
  operation    text NOT NULL,                         -- post_create | post_create_link | post_read | user_lookup
  units        integer NOT NULL DEFAULT 1,
  usd_cost     numeric(10, 5) NOT NULL,
  ref_table    text,                                  -- 'social_posts' | 'social_replies'
  ref_id       bigint,

  -- Negative costs are legal and load-bearing: when a reserved call
  -- never reaches X (a local guard rejects it, or X 4xxs without
  -- billing) we append a compensating negative row rather than deleting
  -- the debit. The ledger stays append-only, so month-to-date is always
  -- a plain SUM and the history of what we thought we spent survives.
  CONSTRAINT social_spend_units_chk CHECK (units > 0)
);

-- The budget check runs before every metered call, so it must be an
-- index-only sum over the current month.
CREATE INDEX IF NOT EXISTS idx_social_spend_month
  ON public.social_spend (occurred_at, usd_cost);

-- Month-to-date spend in USD. Kept in SQL so the number the guard sees
-- and the number the dashboard shows can never drift apart.
CREATE OR REPLACE FUNCTION public.social_spend_mtd()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(usd_cost), 0)::numeric
  FROM public.social_spend
  WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC');
$$;


-- 5. RLS LOCKDOWN -------------------------------------------------
-- No client ever touches these tables. Enabling RLS without adding a
-- single permissive policy denies anon and authenticated by default;
-- service-role bypasses RLS entirely, which is exactly the access the
-- cron routes have and nothing else does.
ALTER TABLE public.social_posts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_spend   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.social_posts   FROM anon, authenticated;
REVOKE ALL ON public.social_targets FROM anon, authenticated;
REVOKE ALL ON public.social_replies FROM anon, authenticated;
REVOKE ALL ON public.social_spend   FROM anon, authenticated;

-- social_spend_mtd() is SECURITY DEFINER; keep it off the client too.
REVOKE ALL ON FUNCTION public.social_spend_mtd() FROM anon, authenticated;


-- 6. updated_at TOUCH ---------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_social_posts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_social_posts_updated_at ON public.social_posts;
CREATE TRIGGER trg_social_posts_updated_at
  BEFORE UPDATE ON public.social_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_social_posts_updated_at();
