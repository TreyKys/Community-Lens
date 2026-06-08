-- Leaderboard pre-launch waitlist.
--
-- /leaderboard is shipping as a teaser ahead of the actual ranking system.
-- We need a list of interested users (signed-in OR anonymous) so we can:
--   (a) email them when the leaderboard goes live
--   (b) seed FOMO: cap is exposed in the public count + slot endpoint, so
--       the page can show "X/Y slots claimed".

CREATE TABLE IF NOT EXISTS public.leaderboard_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  email text NOT NULL,
  phone text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

-- Fast count() for the public slots-remaining endpoint.
CREATE INDEX IF NOT EXISTS leaderboard_waitlist_created_at_idx
  ON public.leaderboard_waitlist (created_at);

-- Look up by user_id so we can tell signed-in users "you're already in".
CREATE INDEX IF NOT EXISTS leaderboard_waitlist_user_id_idx
  ON public.leaderboard_waitlist (user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.leaderboard_waitlist ENABLE ROW LEVEL SECURITY;

-- All writes go through the service-role API route. No client-side inserts.
-- Reads are also restricted — the public slot count is computed server-side
-- in the API and never exposes raw rows.
CREATE POLICY "leaderboard_waitlist service-role only"
  ON public.leaderboard_waitlist FOR ALL
  USING (false)
  WITH CHECK (false);
