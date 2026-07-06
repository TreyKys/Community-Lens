-- Leaderboard ranking function.
--
-- One canonical ranking used by the admin preview now and the public
-- leaderboard at rollout. Ranks predictors by POINTS, which already
-- blend volume (1pt/₦250 staked) and skill (1pt/₦100 profit) + referral
-- rewards, all timestamped in points_log since launch.
--
-- p_since:
--   NULL          → All-Time board (users.points cumulative)
--   a timestamptz → windowed board (sum of points_log since that instant)
--                   e.g. Monday 00:00 WAT for Weekly, today 00:00 WAT for Daily.
--
-- Returns each ranked user with their windowed points plus an all-time
-- accuracy snapshot (resolved/won counts) and lifetime volume, so the
-- board can show "who's winning" AND "how sharp are they".
--
-- Accuracy is computed only for the top p_limit rows (ranked + limited
-- in the CTE first), so the LATERAL bet aggregation stays cheap.

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
    -- All-time branch
    SELECT u.id AS user_id, u.points::numeric AS pts
    FROM public.users u
    WHERE p_since IS NULL AND COALESCE(u.points, 0) > 0
    UNION ALL
    -- Windowed branch
    SELECT pl.user_id, SUM(pl.points)::numeric AS pts
    FROM public.points_log pl
    WHERE p_since IS NOT NULL AND pl.created_at >= p_since
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

REVOKE ALL ON FUNCTION public.leaderboard_points(timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard_points(timestamptz, integer) TO service_role, authenticated;

COMMENT ON FUNCTION public.leaderboard_points IS
  'Points-ranked leaderboard. p_since NULL = all-time (users.points); a timestamp = windowed (sum of points_log since then) for Daily/Weekly boards. Returns windowed points + all-time accuracy (resolved/won) + lifetime volume for the top p_limit users.';

NOTIFY pgrst, 'reload schema';
