-- admin_alert notifications had no cooldown or de-duplication: a
-- persistent condition (a market stuck past its resolution-attempt
-- ceiling in resolve-due, a trading-health check still critical in
-- cron/open-markets) re-inserted the same alert on EVERY cron tick
-- that found it still true — 288/day from resolve-due (every 5 min),
-- 96/day from cron/open-markets (every 15 min), for as long as a
-- single issue stayed unresolved. That's real, continuous write load
-- on this table around the clock, independent of any real traffic,
-- and it's the largest concrete lead found for why the disk I/O
-- budget had so little headroom before the Sept 27 promo traffic.
--
-- alert_key lets lib/adminAlert.ts's sendAdminAlert() check "have I
-- already alerted about THIS specific thing recently" before
-- inserting — nullable so every existing row and every OTHER
-- notification type (bet_won, deposit, etc.) is untouched.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS alert_key text;

-- Partial index on exactly sendAdminAlert's own query — without it,
-- that lookup walks every admin_alert row ever inserted, on every
-- single cron tick, which is the same "unbounded scan on a cron
-- cadence" mistake this migration is fixing in the first place.
CREATE INDEX IF NOT EXISTS notifications_admin_alert_key_idx
  ON public.notifications (alert_key, created_at DESC)
  WHERE type = 'admin_alert' AND alert_key IS NOT NULL;
