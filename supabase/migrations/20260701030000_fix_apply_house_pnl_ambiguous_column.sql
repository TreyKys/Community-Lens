-- Fix apply_house_pnl: ambiguous column reference on total_tngn/floor_tngn.
--
-- apply_house_pnl's RETURNS TABLE declares OUTPUT columns named
-- total_tngn and floor_tngn. Those names come into scope as plpgsql
-- variables for the whole function body — so the UNQUALIFIED
-- `total_tngn`/`floor_tngn` references inside the UPDATE ... SET and
-- RETURNING clauses collide with public.house_reserve's OWN columns of
-- the same name, and Postgres raises:
--
--   42702: column reference "total_tngn" is ambiguous
--
-- This was hit live during manual settlement recovery on 2026-07-01 —
-- apply_house_pnl call sites (every market resolution, both engines)
-- started failing at exactly this line under some connection/session
-- plpgsql.variable_conflict setting where the ambiguity actually
-- raises instead of silently resolving. Fix: alias the target table in
-- the UPDATE (hr) and qualify every reference, matching the direct SQL
-- fix already applied to the live database — this migration just makes
-- that fix permanent so a future migration replacing this function
-- doesn't regress it.

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

  UPDATE public.house_reserve hr
    SET total_tngn = COALESCE(hr.total_tngn, 0) + p_pnl_tngn,
        updated_at = now()
  WHERE hr.id = 1
  RETURNING hr.total_tngn, hr.floor_tngn INTO v_new_total, v_floor;

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

NOTIFY pgrst, 'reload schema';
