-- Streaks: reward the habit, not just the bet.
--
-- Every reward on this platform so far is tied to winning. That means the only
-- reason to open the app is to have money riding on something, and a user with
-- nothing live has no reason to look. Streaks give the quiet days a purpose —
-- which is the whole point of a retention loop.
--
-- Paid in BONUS balance, never cash. Bonus is non-withdrawable and must be
-- staked, so a streak reward returns to the product rather than to a bank
-- account, and the existing bonus/cash split ladder handles what a win on
-- bonus money is worth. That is what makes these numbers affordable.
--
-- DAYS ARE AFRICA/LAGOS DAYS. A user in Lagos who stakes at 11pm and again at
-- 1am has used two calendar days locally but one UTC day; counting in UTC
-- would silently break their streak while their phone says otherwise. There is
-- no argument for UTC here — every user is in one timezone.

-- ── One row per user per day ───────────────────────────────────────────────
-- Streaks are DERIVED from this rather than stored as counters. A stored
-- counter is a cache that drifts: a missed write, a replayed webhook or a
-- timezone edge silently corrupts it, and nothing ever recomputes it. Rows of
-- what actually happened can always be re-read.
CREATE TABLE IF NOT EXISTS public.user_activity_days (
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day           date NOT NULL,               -- Africa/Lagos calendar day
  opened        boolean NOT NULL DEFAULT false,
  staked_tngn   numeric NOT NULL DEFAULT 0 CHECK (staked_tngn >= 0),
  stake_count   integer NOT NULL DEFAULT 0 CHECK (stake_count >= 0),
  trade_count   integer NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  -- Which market categories were staked on. Powers the explorer streak
  -- without a second table; the cardinality is tiny (7 categories).
  categories    text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS user_activity_days_user_idx
  ON public.user_activity_days (user_id, day DESC);

ALTER TABLE public.user_activity_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_activity_days_owner_read ON public.user_activity_days;
CREATE POLICY user_activity_days_owner_read ON public.user_activity_days
  FOR SELECT USING (auth.uid() = user_id);

-- ── Claims ledger ──────────────────────────────────────────────────────────
-- The anchor that makes claiming idempotent. UNIQUE on (user, streak, period)
-- means a double tap, a retried request or two tabs cannot pay twice — the
-- second insert simply loses.
CREATE TABLE IF NOT EXISTS public.streak_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  streak_id   text NOT NULL,
  -- The period this claim covers, so a repeatable streak can pay again next
  -- time without ever paying twice for the same run.
  period_key  text NOT NULL,
  reward_tngn numeric NOT NULL CHECK (reward_tngn > 0),
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, streak_id, period_key)
);

ALTER TABLE public.streak_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS streak_claims_owner_read ON public.streak_claims;
CREATE POLICY streak_claims_owner_read ON public.streak_claims
  FOR SELECT USING (auth.uid() = user_id);

-- ── Record activity ────────────────────────────────────────────────────────
-- Called on sign-in and after every stake or trade. Upsert so the same day is
-- accumulated rather than overwritten.
CREATE OR REPLACE FUNCTION public.record_streak_activity(
  p_user_id   uuid,
  p_opened    boolean DEFAULT true,
  p_staked_tngn numeric DEFAULT 0,
  p_is_trade  boolean DEFAULT false,
  p_category  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.user_activity_days AS d
    (user_id, day, opened, staked_tngn, stake_count, trade_count, categories)
  VALUES (
    p_user_id, v_day, COALESCE(p_opened, false),
    GREATEST(COALESCE(p_staked_tngn, 0), 0),
    CASE WHEN COALESCE(p_staked_tngn,0) > 0 AND NOT COALESCE(p_is_trade,false) THEN 1 ELSE 0 END,
    CASE WHEN COALESCE(p_is_trade,false) THEN 1 ELSE 0 END,
    CASE WHEN p_category IS NULL THEN '{}'::text[] ELSE ARRAY[lower(btrim(p_category))] END
  )
  ON CONFLICT (user_id, day) DO UPDATE SET
    -- opened is sticky: once true for the day it stays true, so a later stake
    -- call passing false cannot erase the visit.
    opened      = d.opened OR EXCLUDED.opened,
    staked_tngn = d.staked_tngn + EXCLUDED.staked_tngn,
    stake_count = d.stake_count + EXCLUDED.stake_count,
    trade_count = d.trade_count + EXCLUDED.trade_count,
    categories  = ARRAY(SELECT DISTINCT unnest(d.categories || EXCLUDED.categories)),
    updated_at  = now();
END;
$$;

-- ── Streak state ───────────────────────────────────────────────────────────
-- Everything the UI needs for all five streaks, in one call. Returns progress
-- as well as completion, because a bar at 5/7 is the thing that brings someone
-- back tomorrow — a reward that only appears once earned motivates nobody.
CREATE OR REPLACE FUNCTION public.get_streak_state(p_user_id uuid)
RETURNS TABLE (
  streak_id   text,
  label       text,
  detail      text,
  progress    integer,
  target      integer,
  reward_tngn numeric,
  period_key  text,
  claimable   boolean,
  claimed     boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  -- ISO week is the period for the weekly streaks: it rolls over on a fixed
  -- boundary for everyone rather than depending on when each user started,
  -- which keeps "this week" meaning the same thing across the whole product.
  v_week   text := to_char(v_today, 'IYYY-"W"IW');
  v_month  text := to_char(v_today, 'YYYY-MM');

  v_login_run  integer := 0;
  v_stake_run  integer := 0;
  v_cats       integer := 0;
  v_trades     integer := 0;
  v_cursor     date;
  r            record;

  -- A day only counts toward the staking streak if real money moved. Without
  -- a floor, seven ₦100 stakes (₦700) would earn ₦500 — a 71% rebate, and
  -- trivially farmable. At ₦500/day it is ₦3,500 for ₦500, which is a
  -- promotion rather than an arbitrage.
  c_min_daily_stake constant numeric := 500;
BEGIN
  -- Consecutive days ending today or yesterday. Yesterday is allowed so the
  -- streak does not appear broken all morning before the user has opened the
  -- app — it breaks only once a full day has been missed.
  v_cursor := v_today;
  IF NOT EXISTS (SELECT 1 FROM public.user_activity_days
                  WHERE user_id = p_user_id AND day = v_today AND opened) THEN
    v_cursor := v_today - 1;
  END IF;

  LOOP
    SELECT * INTO r FROM public.user_activity_days
     WHERE user_id = p_user_id AND day = v_cursor;
    EXIT WHEN NOT FOUND OR NOT r.opened;
    v_login_run := v_login_run + 1;
    v_cursor := v_cursor - 1;
    EXIT WHEN v_login_run >= 60;   -- no streak in this set needs more
  END LOOP;

  -- Same walk, but a day only counts if it cleared the stake floor.
  v_cursor := v_today;
  IF NOT EXISTS (SELECT 1 FROM public.user_activity_days
                  WHERE user_id = p_user_id AND day = v_today
                    AND staked_tngn >= c_min_daily_stake) THEN
    v_cursor := v_today - 1;
  END IF;
  LOOP
    SELECT * INTO r FROM public.user_activity_days
     WHERE user_id = p_user_id AND day = v_cursor;
    EXIT WHEN NOT FOUND OR r.staked_tngn < c_min_daily_stake;
    v_stake_run := v_stake_run + 1;
    v_cursor := v_cursor - 1;
    EXIT WHEN v_stake_run >= 30;
  END LOOP;

  -- Weekly totals, ISO week to date.
  SELECT COUNT(DISTINCT c) INTO v_cats
    FROM public.user_activity_days d, unnest(d.categories) c
   WHERE d.user_id = p_user_id
     AND to_char(d.day, 'IYYY-"W"IW') = v_week;

  SELECT COALESCE(SUM(trade_count), 0) INTO v_trades
    FROM public.user_activity_days
   WHERE user_id = p_user_id
     AND to_char(day, 'IYYY-"W"IW') = v_week;

  RETURN QUERY
  WITH defs(streak_id, label, detail, progress, target, reward_tngn, period_key) AS (
    VALUES
      -- Daily habit. Small, easy, and the on-ramp to everything below.
      ('login_7',   'Show up',        'Open the app 7 days running',
       LEAST(v_login_run, 7),  7,  200::numeric, v_month || ':' || (v_login_run / 7)::text),
      -- The one that pays for itself: seven days of real staking.
      ('stake_7',   'Seven straight', 'Stake or trade ₦500+ on 7 days running',
       LEAST(v_stake_run, 7),  7,  500::numeric, v_month || ':' || (v_stake_run / 7)::text),
      -- The long haul. Same action as login_7, an order of magnitude more
      -- commitment, so it pays the cap.
      ('login_30',  'Regular',        'Open the app 30 days running',
       LEAST(v_login_run, 30), 30, 500::numeric, v_month),
      -- Drives discovery of the hubs. Someone who only ever bets football
      -- never learns the rest of the site exists.
      ('explorer',  'Get around',     'Stake in 3 different categories this week',
       LEAST(v_cats, 3),       3,  300::numeric, v_week),
      -- Drives adoption of the trading engine specifically, which is the
      -- newest and least understood thing here.
      ('trader_5',  'Active trader',  'Make 5 trades this week',
       LEAST(v_trades, 5),     5,  400::numeric, v_week)
  )
  SELECT d.streak_id, d.label, d.detail, d.progress, d.target, d.reward_tngn, d.period_key,
         (d.progress >= d.target
           AND NOT EXISTS (SELECT 1 FROM public.streak_claims c
                            WHERE c.user_id = p_user_id
                              AND c.streak_id = d.streak_id
                              AND c.period_key = d.period_key)) AS claimable,
         EXISTS (SELECT 1 FROM public.streak_claims c
                  WHERE c.user_id = p_user_id
                    AND c.streak_id = d.streak_id
                    AND c.period_key = d.period_key) AS claimed
    FROM defs d;
END;
$$;

-- ── Claim ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_streak_reward(
  p_user_id   uuid,
  p_streak_id text
)
RETURNS TABLE (applied boolean, reason text, reward_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Sign in first', 0::numeric; RETURN;
  END IF;

  -- Eligibility is re-derived here, not trusted from the caller. The UI's copy
  -- of the state is stale the moment it is rendered, and this is a payout.
  SELECT * INTO s FROM public.get_streak_state(p_user_id)
   WHERE streak_id = p_streak_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Unknown streak', 0::numeric; RETURN;
  END IF;
  IF s.claimed THEN
    RETURN QUERY SELECT false, 'Already claimed', 0::numeric; RETURN;
  END IF;
  IF NOT s.claimable THEN
    RETURN QUERY SELECT false,
      'Not finished yet — ' || s.progress || ' of ' || s.target, 0::numeric;
    RETURN;
  END IF;

  -- The UNIQUE constraint is the real guard, not the check above: two
  -- simultaneous requests both pass the read and only one can insert.
  BEGIN
    INSERT INTO public.streak_claims (user_id, streak_id, period_key, reward_tngn)
    VALUES (p_user_id, p_streak_id, s.period_key, s.reward_tngn);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, 'Already claimed', 0::numeric; RETURN;
  END;

  -- Bonus, never cash. credit_user is safe for a credit; its clamp at zero
  -- only makes it unsound as a debit.
  PERFORM public.credit_user(p_user_id, 0, s.reward_tngn);

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
  VALUES ('streak_reward', -s.reward_tngn, p_user_id,
          jsonb_build_object('streak_id', p_streak_id, 'period', s.period_key));

  INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
  VALUES (p_user_id, 'streak_reward',
          s.label || ' complete — ₦' || to_char(s.reward_tngn, 'FM999,999') || ' bonus added',
          s.reward_tngn, 'success', '/dashboard');

  RETURN QUERY SELECT true, 'paid', s.reward_tngn;
END;
$$;

REVOKE ALL ON FUNCTION public.record_streak_activity(uuid, boolean, numeric, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_streak_activity(uuid, boolean, numeric, boolean, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.get_streak_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_streak_state(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.claim_streak_reward(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_streak_reward(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
