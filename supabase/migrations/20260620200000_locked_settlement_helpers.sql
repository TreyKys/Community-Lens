-- Phase 4: helper RPCs for locked-odds settlement.
--
-- The resolve route stays in TypeScript (matching the existing
-- parimutuel pattern) but needs two atomic primitives that are
-- inappropriate to do via raw UPDATE through the supabase-js client:
--   1. apply_house_pnl  — house P&L adjustment to the singleton
--      house_reserve. We want a SECURITY DEFINER RPC so the reserve
--      table stays service-role only and we get a single auditable
--      surface for "anything that mutates the reserve".
--   2. clear_market_liability — once a market is settled, its
--      liability row should be deleted (it's no longer open
--      exposure). One-line operation but again wrapped for the same
--      audit-surface reason.
--
-- Both are intentionally tiny. The complex math lives in
-- lib/lockedSettlement.ts and is exercised by 22 unit tests.

-- ── apply_house_pnl ─────────────────────────────────────────────────
--
-- Atomically adjust house_reserve.total_tngn by the given delta.
-- Positive = profit (reserve grows); negative = loss (reserve
-- shrinks). Returns the post-update totals so callers can log /
-- monitor without an extra round-trip.
--
-- Does NOT block the adjustment if it would push total below floor:
-- payouts to users must always go out, and we'd rather have a
-- (rare) negative deployable + an auto-pause + an ops alert than a
-- settlement that hangs because the reserve check failed. The
-- dynamic stake cap + auto-pause logic (Phase 6) is responsible for
-- preventing us from getting close to the floor in the first place.

CREATE OR REPLACE FUNCTION public.apply_house_pnl(
  p_pnl_tngn numeric,
  p_market_id bigint DEFAULT NULL
)
RETURNS TABLE (
  total_tngn       numeric,
  floor_tngn       numeric,
  deployable_tngn  numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total numeric;
  v_floor     numeric;
BEGIN
  IF p_pnl_tngn IS NULL THEN
    RAISE EXCEPTION 'apply_house_pnl: p_pnl_tngn cannot be null' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.house_reserve
    SET total_tngn = COALESCE(total_tngn, 0) + p_pnl_tngn,
        updated_at = now()
  WHERE id = 1
  RETURNING total_tngn, floor_tngn INTO v_new_total, v_floor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_house_pnl: house_reserve singleton missing'
      USING ERRCODE = 'P0003';
  END IF;

  RETURN QUERY SELECT
    v_new_total,
    v_floor,
    GREATEST(0, v_new_total - v_floor);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_house_pnl(numeric, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_house_pnl(numeric, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.apply_house_pnl(numeric, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_house_pnl(numeric, bigint) TO service_role;

COMMENT ON FUNCTION public.apply_house_pnl IS
  'Atomically adjust the house reserve total. Called once per locked-odds market settlement with the final house P&L (positive=profit, negative=loss). p_market_id is optional and stored only for audit context — the actual reserve mutation is the single UPDATE on house_reserve.id=1.';

-- ── clear_market_liability ──────────────────────────────────────────
--
-- After a locked-odds market resolves, its liability is realised
-- (paid out or kept). The market_liability row is no longer "open
-- exposure" and should be removed so the aggregate-worst-case
-- computation used by the dynamic stake cap stays accurate.

CREATE OR REPLACE FUNCTION public.clear_market_liability(
  p_market_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_market_id IS NULL THEN
    RAISE EXCEPTION 'clear_market_liability: p_market_id cannot be null' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.market_liability WHERE market_id = p_market_id;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_market_liability(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_market_liability(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.clear_market_liability(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_market_liability(bigint) TO service_role;

COMMENT ON FUNCTION public.clear_market_liability IS
  'Drop the per-market liability row after settlement. The exposure is no longer open; aggregate-worst-case for auto-pause / stake-cap purposes should not include it.';

NOTIFY pgrst, 'reload schema';
