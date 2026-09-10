-- A real "top up the reserve" lever. Until now the only way to add capital
-- to house_reserve.total_tngn was a hand-typed UPDATE in the SQL editor —
-- which happened for real, live, on 2026-09-08, because the reserve had
-- drifted below its own floor (₦15,857.46 against a ₦30,000 floor) with
-- nothing due to settle for 51 days, and there was no other way to unblock
-- it. That gap is what this closes.
--
-- Deliberately narrower than the Open Markets admin controls
-- (20260907000000): this page's admin actions have never carried a
-- per-admin uuid (isAdminRequest is a single shared secret, not individual
-- accounts — see /api/admin/credits, which is the closest existing analog:
-- a mandatory reason and a sanity cap, no admin identity). Matching that
-- convention rather than importing the Open Markets four-eyes pattern
-- somewhere it was never designed to apply.
CREATE OR REPLACE FUNCTION public.admin_topup_house_reserve(
  p_amount_tngn numeric,
  p_reason      text
)
RETURNS TABLE (applied boolean, reason text, new_total_tngn numeric, new_deployable_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total numeric;
  v_floor     numeric;
BEGIN
  IF p_amount_tngn IS NULL OR p_amount_tngn <= 0 THEN
    RETURN QUERY SELECT false, 'Amount must be a positive number', NULL::numeric, NULL::numeric;
    RETURN;
  END IF;
  -- Same shape as /api/admin/credits' ₦1,000,000 per-issuance cap on user
  -- credits — a sanity ceiling that catches a fat-fingered extra zero
  -- without blocking a genuine large injection: run it twice rather than
  -- once for anything bigger than this.
  IF p_amount_tngn > 10_000_000 THEN
    RETURN QUERY SELECT false, 'Single top-up capped at ₦10,000,000 — run it again for more', NULL::numeric, NULL::numeric;
    RETURN;
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN
    RETURN QUERY SELECT false, 'Say why this capital is being added', NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  UPDATE public.house_reserve
     SET total_tngn = total_tngn + p_amount_tngn,
         updated_at = now()
   WHERE id = 1
  RETURNING total_tngn, floor_tngn INTO v_new_total, v_floor;

  IF NOT FOUND THEN
    -- Should not happen post-migration (the singleton row is seeded by
    -- 20260620170000), but this function must never silently no-op on
    -- real money.
    RETURN QUERY SELECT false, 'house_reserve row missing — nothing was applied', NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- Same treasury_log audit trail every other money movement on this
  -- platform leaves. type is new ('reserve_topup') because this is neither
  -- a user-facing credit nor a settlement P&L — it is capital, and it
  -- should read as capital in the ledger, not get folded into either.
  INSERT INTO public.treasury_log (type, amount_tngn, user_id, metadata)
  VALUES ('reserve_topup', p_amount_tngn, NULL, jsonb_build_object(
    'reason', p_reason,
    'new_total_tngn', v_new_total
  ));

  RETURN QUERY SELECT true, 'topped up', v_new_total, GREATEST(0, v_new_total - v_floor);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_topup_house_reserve(numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_topup_house_reserve(numeric, text) TO service_role;

NOTIFY pgrst, 'reload schema';
