-- Leaderboard: rank by prediction activity only, not referral rewards.
--
-- Reported: a user with 20-30 pts yesterday showed 1000+ today, when
-- they hadn't made any new predictions. Cause: the referral signup
-- bonus (20260611100000_vip_referral_signup_bonus.sql:175) credits the
-- referrer with +1000 points for a VIP-coded signup, and +200 for a
-- normal-coded one. These land in points_log alongside bet_volume and
-- bet_win entries, and the original leaderboard RPC summed everything
-- indiscriminately. One referral signup dwarfed weeks of real
-- prediction activity.
--
-- We rebuild the ranking from points_log only, filtering referral
-- rewards. The bonuses stay where they are (users.points still
-- reflects them, the wallet tile still shows them, points_log keeps
-- the audit row) — they're just not part of the public leaderboard
-- standing anymore. Leaderboard reads:
--   • All-Time   = SUM(points_log.points) since launch, ex-referral
--   • Windowed   = SUM(points_log.points) since p_since,   ex-referral
--
-- Same return shape as before so the API + client stay untouched.

CREATE OR REPLACE FUNCTION public.leaderboard_points(
  p_since timestamptz,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  user_id        uuid,
  username       text,
  avatar_id      integer,
  points_window  numeric,
  resolved_bets  bigint,
  won_bets       bigint,
  volume_tngn    numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT pl.user_id, SUM(pl.points)::numeric AS pts
    FROM public.points_log pl
    WHERE
      -- Referral bonuses (200 for normal, 1000 for VIP) overwhelm the
      -- volume / win rewards that ranking should reflect. Strip them.
      -- Also strips referral_signup_bonus in case future migrations
      -- introduce that reason.
      pl.reason NOT IN ('referral_normal', 'referral_vip', 'referral_signup_bonus')
      AND (p_since IS NULL OR pl.created_at >= p_since)
    GROUP BY pl.user_id
    HAVING SUM(pl.points) > 0
  ),
  top AS (
    SELECT user_id, pts FROM base ORDER BY pts DESC LIMIT GREATEST(1, p_limit)
  )
  SELECT
    t.user_id,
    u.username,
    u.avatar_id,
    t.pts AS points_window,
    COALESCE(b.resolved, 0) AS resolved_bets,
    COALESCE(b.won, 0)      AS won_bets,
    COALESCE(b.volume, 0)   AS volume_tngn
  FROM top t
  JOIN public.users u ON u.id = t.user_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('won', 'lost')) AS resolved,
      COUNT(*) FILTER (WHERE status = 'won')            AS won,
      COALESCE(SUM(stake_tngn), 0)                      AS volume
    FROM public.user_bets ub
    WHERE ub.user_id = t.user_id
  ) b ON true
  ORDER BY t.pts DESC;
$$;

COMMENT ON FUNCTION public.leaderboard_points IS
  'Points-ranked leaderboard. Reads SUM(points_log.points) for both all-time (p_since NULL) and windowed (p_since timestamp) views, excluding referral rewards (200 / 1000 lump sums that would otherwise dwarf prediction activity). Returns windowed points + all-time accuracy (resolved/won) + lifetime volume for the top p_limit users.';

NOTIFY pgrst, 'reload schema';
