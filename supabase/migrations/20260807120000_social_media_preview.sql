-- ================================================================
-- Preview stage: see every queued post, decide its image.
-- ================================================================
-- Until now media_url was set once by the planner and never revisited.
-- A briefed post got no image at all, and there was no way to look at
-- what was about to go out, let alone change it.
--
-- Images are not decoration here. A post with a link costs 13.3x at
-- X's metered API, so the brand cannot travel in a URL — it travels in
-- the picture. An image is also the difference between a post that
-- stops a thumb and one that does not.
-- ================================================================


-- 1. What image, if any -------------------------------------------
--   none      — text only
--   auto_card — we render an anticipation card from the post's own text
--   upload    — the operator sent a photo; media_url holds tg:<file_id>
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'none';

ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_media_kind_chk;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_media_kind_chk CHECK (
    media_kind IN ('none', 'auto_card', 'upload')
  );

-- Anything with a media_url predates this column and is a rendered
-- market card, which is the auto_card case.
UPDATE public.social_posts
   SET media_kind = 'auto_card'
 WHERE media_url IS NOT NULL AND media_kind = 'none';

-- A kind that needs a source must have one, and 'none' must not carry a
-- stale URL from a previous choice — otherwise flipping to "no image"
-- would leave the publisher still attaching one.
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_media_consistency_chk;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_media_consistency_chk CHECK (
    (media_kind = 'none'   AND media_url IS NULL) OR
    (media_kind <> 'none'  AND media_url IS NOT NULL)
  );


-- 2. The card's own styling ---------------------------------------
-- Which OPx theme to render an auto_card in. Null means the default.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS card_theme text;

-- A short eyebrow above the headline on the card — "BBN", "SUPER
-- EAGLES", "NAIRA WATCH". Derived from the brief when the planner has
-- one, overridable from Telegram.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS card_kicker text;

ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_card_kicker_chk;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_card_kicker_chk CHECK (
    card_kicker IS NULL OR char_length(card_kicker) BETWEEN 1 AND 24
  );


-- 3. Which post is waiting for a photo ----------------------------
-- Telegram photos arrive as their own message with no reliable link to
-- what they are for. Tapping "Upload" parks the post id here, and the
-- next photo claims it. Replying directly to a card also works and is
-- preferred; this covers the case where the operator just sends one.
ALTER TABLE public.social_settings
  ADD COLUMN IF NOT EXISTS awaiting_media_post_id bigint
    REFERENCES public.social_posts(id) ON DELETE SET NULL;

ALTER TABLE public.social_settings
  ADD COLUMN IF NOT EXISTS awaiting_media_since timestamptz;

COMMENT ON COLUMN public.social_settings.awaiting_media_post_id IS
  'Post that tapped Upload and is waiting for the next photo. Expires after a few minutes so a stray photo cannot attach itself to something forgotten.';
