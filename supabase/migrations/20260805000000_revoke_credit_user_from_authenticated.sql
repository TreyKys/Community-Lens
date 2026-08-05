-- ============================================================================
-- SECURITY (P0): revoke credit_user from authenticated
-- ============================================================================
-- credit_user is the function that actually moves wallet balances:
--
--   UPDATE public.users
--      SET tngn_balance  = GREATEST(COALESCE(tngn_balance, 0)  + p_tngn_delta, 0),
--          bonus_balance = GREATEST(COALESCE(bonus_balance, 0) + p_bonus_delta, 0)
--    WHERE id = p_user_id;
--
-- It is SECURITY DEFINER (so it bypasses RLS) and it takes p_user_id as a
-- PARAMETER rather than deriving it from auth.uid(). Migration
-- 20240621100000_atomic_credit_user.sql granted EXECUTE to `authenticated`,
-- and nothing since revoked it.
--
-- That combination is directly exploitable by any signed-in user holding the
-- public anon key:
--
--   supabase.rpc('credit_user', {
--     p_user_id: <their own id>, p_tngn_delta: 5000000, p_bonus_delta: 0
--   })
--
-- tngn_balance is the balance /api/withdraw pays out from, so this is a
-- mint-and-cash-out path, not merely a display bug.
--
-- Every other money-moving function in this schema already carries the
-- REVOKE line -- place_bet, place_bet_locked, place_multiplier_slip,
-- settle_bet_outcome, apply_house_pnl, bonus_winnings_split,
-- settle_squad_deposit, reclaim_slip_bonus_split. credit_user was the single
-- omission, and it is the most powerful of them.
--
-- Nothing legitimate breaks: every caller is server-side and uses the
-- service-role key (resolve, settlement, deposits, insurance, VIP cuts,
-- reconciliation). No browser code path calls it.
-- ============================================================================

REVOKE ALL ON FUNCTION public.credit_user(uuid, numeric, numeric)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.credit_user(uuid, numeric, numeric)
  TO service_role;

COMMENT ON FUNCTION public.credit_user IS
  'Atomic wallet credit. SERVICE ROLE ONLY -- it is SECURITY DEFINER and takes '
  'p_user_id as a parameter, so granting it to authenticated lets any signed-in '
  'user mint withdrawable balance for any account. See migration 20260805000000.';

-- ── Defence in depth: balances can never go negative ────────────────────────
-- credit_user CLAMPS at zero rather than raising, which means an over-debit
-- silently succeeds and the shortfall disappears instead of failing loudly.
-- This constraint turns that class of accounting error into a visible error.
--
-- NOT VALID so it applies to all new writes immediately without scanning (or
-- failing on) existing rows. Validate separately once the audit below is clean:
--   ALTER TABLE public.users VALIDATE CONSTRAINT users_balances_nonneg;
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_balances_nonneg;
ALTER TABLE public.users
  ADD CONSTRAINT users_balances_nonneg
  CHECK (COALESCE(tngn_balance, 0) >= 0 AND COALESCE(bonus_balance, 0) >= 0)
  NOT VALID;

NOTIFY pgrst, 'reload schema';
