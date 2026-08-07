-- ================================================================
-- Briefed drafts: posts written from an instruction, not a market.
-- ================================================================
-- The planner only ever wrote posts ABOUT open markets, ranked by which
-- closed soonest. On a real morning that surfaced Dutch second-division
-- fixtures with terse auto-seeded titles and no pool data, and the
-- model — handed a market with no numbers and no hook — echoed the
-- title back ("Cambuur vs Excelsior (DED)").
--
-- The fix is not a better prompt. It is that the operator, not the
-- fixture list, decides what the account talks about. "Draft 4 BBN
-- posts" is a better brief than anything the market table can supply,
-- and most of what an audience wants to hear about is not a market at
-- all.
--
-- So drafts now arrive from Telegram, are reviewed on the phone, and
-- only reach the publishing queue when the operator picks them.
-- ================================================================


-- 1. A 'draft' status ---------------------------------------------
-- Drafts sit outside the queue entirely: the publisher's query filters
-- on status = 'queued', so a draft can never publish by accident, no
-- matter what its schedule says.
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_status_chk;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_chk CHECK (
    status IN ('draft', 'queued', 'publishing', 'published', 'failed', 'skipped', 'cancelled')
  );


-- 2. Drafts carry no schedule -------------------------------------
-- A slot is assigned at the moment the operator taps Queue, not when
-- the draft is written. Until then scheduled_at is null, same as the
-- evergreen pool.
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_scheduled_chk;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_scheduled_chk CHECK (
    scheduled_at IS NOT NULL OR kind = 'evergreen' OR status = 'draft'
  );


-- 3. What was asked for -------------------------------------------
-- The operator's own words, kept against the draft. Two reasons: the
-- review card can show what you asked for next to what you got, and a
-- brief that reliably produces good posts is worth being able to find
-- again.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS brief text;

COMMENT ON COLUMN public.social_posts.brief IS
  'For kind = ''briefed'': the operator instruction this post was written from, verbatim.';


-- 4. Keep the drafting surface from filling up --------------------
-- Drafts that were never picked are noise after a day. This index
-- makes the sweep cheap; the sweep itself runs in the planner.
CREATE INDEX IF NOT EXISTS idx_social_posts_stale_drafts
  ON public.social_posts (created_at)
  WHERE status = 'draft';
