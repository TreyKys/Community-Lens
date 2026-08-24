-- A sixth streak: referrals.
--
-- Referrals were the one acquisition lever already built and wired to nothing
-- the user can see day to day. They pay ₦200 to each side on redemption and
-- then go quiet — there is no reason to send a second invite, and no surface
-- anywhere that says how you are doing.
--
-- WHAT COUNTS IS A FRIEND WHO STAKED, NOT A FRIEND WHO SIGNED UP.
--
-- This is the whole design and it is worth being explicit about why, because
-- the obvious version of this feature loses money on purpose:
--
--   Signing up already pays ₦200 to the referrer and ₦200 to the referee.
--   Add "₦500 for 3 signups" on top and three throwaway accounts are worth
--   ₦1,700 in bonus credit — to one person, with a burner email each, in about
--   four minutes. That is not a referral programme, it is a faucet.
--
-- Requiring each referee to have put c_qualifying_cash of their OWN money
-- through the book closes it. A fake account now has to fund itself and risk
-- real money to be worth anything, at which point it is not a fake account —
-- it is a customer, which is what we wanted to buy in the first place.
--
-- BONUS CREDIT IS EXCLUDED FROM THAT TOTAL for the same reason: the referee
-- was just handed ₦200 of bonus, and counting it would mean the signup bonus
-- pays for the qualification it is supposed to be tested against.

CREATE OR REPLACE FUNCTION public.get_streak_state(p_user_id uuid)
RETURNS TABLE (
  streak_id   text,
  label       text,
  detail      text,
  -- integer, NOT numeric: CREATE OR REPLACE cannot change a function's return
  -- type, and these two were declared integer when this function was first
  -- written. Widening them here would fail to load rather than fail loudly at
  -- runtime, which is at least the right kind of failure — but it would still
  -- block the migration.
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
  v_today      date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  -- ISO week is the period for the weekly streaks: it rolls over on a fixed
  -- boundary for everyone rather than depending on when each user started,
  -- which keeps "this week" meaning the same thing across the whole product.
  v_week       text := to_char(v_today, 'IYYY-"W"IW');
  v_month      text := to_char(v_today, 'YYYY-MM');
  v_login_run  integer := 0;
  v_stake_run  integer := 0;
  v_cats       integer := 0;
  v_trades     integer := 0;
  v_referrals  integer := 0;
  v_cursor     date;
  r            record;

  -- A day only counts toward the staking streak if real money moved. Without
  -- a floor, seven ₦100 stakes (₦700) would earn ₦500 — a 71% rebate, and
  -- trivially farmable. At ₦500/day it is ₦3,500 for ₦500, which is a
  -- promotion rather than an arbitrage.
  c_min_daily_stake constant numeric := 500;

  -- What a referred friend has to have staked, in their OWN cash, before they
  -- count. Set above the ₦200 signup bonus by enough that the bonus cannot
  -- fund the qualification.
  c_qualifying_cash constant numeric := 1000;

  -- Referees examined per call. This runs on every dashboard load, and a user
  -- with a thousand referrals should not turn that into a thousand-row scan.
  -- 60 is twenty claims' worth — far past anyone this milestone is aimed at,
  -- and the cap is documented rather than silent.
  c_referee_scan_cap constant integer := 60;
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

  -- Referred friends who have staked their own cash past the floor.
  --
  -- Counted from the bet and trade logs rather than from user_activity_days,
  -- so a referral made before streaks existed still counts. Reading the
  -- activity table instead would show a long-standing referrer 0 of 3 and
  -- look like the feature was broken.
  --
  -- Bonus is netted out on both sides: user_bets carries the split as a
  -- proportion, open_trades carries paid_cash directly. Sells (delta_shares
  -- negative) are excluded — taking money OUT is not staking it.
  SELECT COUNT(*) INTO v_referrals
    FROM (
      SELECT id FROM public.users
       WHERE referred_by_user_id = p_user_id
       ORDER BY created_at
       LIMIT c_referee_scan_cap
    ) ref
   WHERE (
     COALESCE((SELECT SUM(b.stake_tngn * (1 - LEAST(GREATEST(COALESCE(b.bonus_proportion,0),0),1)))
                 FROM public.user_bets b WHERE b.user_id = ref.id), 0)
   + COALESCE((SELECT SUM(t.paid_cash)
                 FROM public.open_trades t
                WHERE t.user_id = ref.id AND t.delta_shares > 0), 0)
   ) >= c_qualifying_cash;

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
       LEAST(v_trades, 5),     5,  400::numeric, v_week),
      -- Referrals. NO MONTH OR WEEK IN THE PERIOD KEY — the bucket is the
      -- count itself, so three friends pay once and the fourth claim needs
      -- three more. A dated key would let the same three friends be
      -- re-claimed every month forever.
      ('refer_3',   'Bring three',    'Invite 3 friends who each stake ₦1,000+',
       LEAST(v_referrals, 3),  3,  500::numeric, 'ref:' || (v_referrals / 3)::text)
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

-- The referee-side lookups above are per-user sums over the two stake logs.
-- Without these they are sequential scans running on every dashboard load.
CREATE INDEX IF NOT EXISTS user_bets_user_idx ON public.user_bets (user_id);
CREATE INDEX IF NOT EXISTS open_trades_user_idx ON public.open_trades (user_id);

NOTIFY pgrst, 'reload schema';
