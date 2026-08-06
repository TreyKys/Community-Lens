-- ================================================================
-- Social pipeline: runtime control + share-to-bot reply intake.
-- ================================================================
-- Two changes, both driven by the same decision: reply discovery moves
-- from a metered scanner to "the operator shares a post to the bot".
--
--   1. social_settings — a kill switch and caps that can be changed
--      from a phone, without a redeploy. The pipeline spends real money
--      unattended; "stop" must not require an SSH session.
--
--   2. social_replies gains source_url and loses the assumption that
--      every draft came from a scan. A shared post may arrive as a URL
--      or as pasted text with no post id at all.
-- ================================================================


-- 1. RUNTIME CONTROL ---------------------------------------------
-- Singleton row. Enforced by a CHECK on a fixed id rather than a
-- trigger, so a second row is impossible rather than merely unusual.
CREATE TABLE IF NOT EXISTS public.social_settings (
  id                 integer PRIMARY KEY DEFAULT 1,

  -- The kill switch. The publisher checks this before every run, so
  -- flipping it stops posting within the hour with no deploy.
  publishing_paused  boolean NOT NULL DEFAULT false,
  paused_reason      text,
  paused_at          timestamptz,

  -- Overrides SOCIAL_DAILY_POST_CAP when set. Lets the cap be tuned
  -- from Telegram without touching .env on the box.
  daily_post_cap     integer,

  -- Whether a shared post may fall back to a BILLED X API read when the
  -- free oEmbed lookup fails. Default false: with reply discovery now
  -- manual, the budget is meant for posts, and a silent $0.005 per
  -- share is exactly the kind of drip that makes a budget wrong.
  allow_paid_lookup  boolean NOT NULL DEFAULT false,

  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_settings_singleton_chk CHECK (id = 1),
  CONSTRAINT social_settings_cap_chk CHECK (daily_post_cap IS NULL OR daily_post_cap BETWEEN 0 AND 20)
);

INSERT INTO public.social_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;


-- 2. SHARE-TO-BOT INTAKE ------------------------------------------
ALTER TABLE public.social_replies
  -- The permalink the operator shared, kept so a draft can be traced
  -- back to what prompted it.
  ADD COLUMN IF NOT EXISTS source_url text,
  -- 'scan' (the metered watcher) or 'shared' (the operator sent it).
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'scan';

ALTER TABLE public.social_replies
  DROP CONSTRAINT IF EXISTS social_replies_origin_chk;
ALTER TABLE public.social_replies
  ADD CONSTRAINT social_replies_origin_chk CHECK (origin IN ('scan', 'shared'));

-- Pasted text has no post id. The scanner's dedupe index requires one,
-- so shared-by-text rows carry a synthetic 'text:<hash>' id — which
-- also dedupes an accidental double-paste of the same content.
--
-- The unique index stays as it is: uq_social_replies_source already
-- covers source_post_id, and a synthetic id participates in it
-- naturally.

COMMENT ON COLUMN public.social_replies.source_post_id IS
  'Real X post id for shared URLs and scanned posts; synthetic "text:<sha1>" when the operator pasted raw text with no link.';


-- 3. RLS ----------------------------------------------------------
-- Same posture as the rest of the pipeline: service-role only, no
-- client access at all.
ALTER TABLE public.social_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_settings FROM anon, authenticated;


-- 4. updated_at TOUCH ---------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_social_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_social_settings_updated_at ON public.social_settings;
CREATE TRIGGER trg_social_settings_updated_at
  BEFORE UPDATE ON public.social_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_social_settings_updated_at();
