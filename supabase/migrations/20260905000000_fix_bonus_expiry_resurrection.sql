-- Fix: an expired bonus balance comes back to life the next time ANY bonus
-- credit lands, not just when the user places a bet.
--
-- trg_users_bonus_expires (20260630200000) was written to cover every credit
-- path "without touching each function" — it fires on every UPDATE of
-- public.users and, whenever bonus_balance goes up, extends bonus_expires_at.
-- That part works. What it never did is check whether the balance it was
-- extending had already expired.
--
-- Only the staking RPCs (place_bet, place_bet_locked, place_multiplier_slip)
-- actually zero out a stale bonus_balance — and they do it themselves, right
-- before checking whether a stake is affordable. Every OTHER credit path
-- (admin manual credits via credit_user, the signup promo, referral signup
-- bonuses, VIP preloads, merged free-bet credits — anything that just runs
-- bonus_balance = bonus_balance + x) never goes near that check. It reads
-- the column as-is, which still holds the old, already-expired amount,
-- because nothing had zeroed it yet.
--
-- So: user has ₦5,000 bonus that expired three days ago. Nothing has placed
-- a bet since, so the column still says 5000 — spendableBonus() in the app
-- correctly shows ₦0 for it, but the row itself never got zeroed. Admin
-- issues a fresh ₦2,000 bonus. credit_user does
-- bonus_balance = 5000 + 2000 = 7000, the trigger sees an increase and gives
-- it a brand new 7-day window. The dead ₦5,000 just came back to life
-- alongside the new ₦2,000 — "when I issue a new bonus the old one comes
-- back", exactly as reported.
--
-- Fix: the trigger is the one place that already sees every credit path, so
-- it is the one place this needs to be fixed. When bonus_balance increases
-- and the balance it is increasing FROM had already expired, that old
-- balance is dead money that should already have read as zero — so the new
-- balance is just the fresh credit, not old-plus-new. A balance that has not
-- expired yet is untouched, same as before: a genuine top-up still stacks
-- on top of the live remainder and extends its window.

CREATE OR REPLACE FUNCTION public.set_bonus_expires_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_increase numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.bonus_balance, 0) > 0 THEN
      NEW.bonus_expires_at := now() + INTERVAL '7 days';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.bonus_balance, 0) > COALESCE(OLD.bonus_balance, 0) THEN
      -- If the balance being added to had already expired, none of it was
      -- real spendable money the instant before this credit — only the
      -- fresh amount is. Discard the stale carry-over instead of stacking
      -- the new credit on top of it.
      v_increase := COALESCE(NEW.bonus_balance, 0) - COALESCE(OLD.bonus_balance, 0);
      IF OLD.bonus_expires_at IS NOT NULL AND OLD.bonus_expires_at <= now() THEN
        NEW.bonus_balance := v_increase;
      END IF;
      -- Extend to GREATEST(current expiry, now + 7 days) so a shorter
      -- new credit doesn't shrink a longer existing window.
      NEW.bonus_expires_at := GREATEST(
        COALESCE(OLD.bonus_expires_at, now()),
        now() + INTERVAL '7 days'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The function is CREATE OR REPLACE in place; the trigger definition itself
-- is unchanged, but re-asserting it here keeps this migration self-contained
-- and safe to apply to a database that somehow lost the trigger without
-- losing the function.
DROP TRIGGER IF EXISTS trg_users_bonus_expires ON public.users;
CREATE TRIGGER trg_users_bonus_expires
  BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_bonus_expires_at();
