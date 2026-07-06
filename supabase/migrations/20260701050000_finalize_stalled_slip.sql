-- Finalize a Multiplier slip whose legs are ALL already settled
-- (won/lost/void) but the slip row itself never advanced to a final
-- status. This is a distinct fingerprint from an orphaned ACTIVE leg:
-- settle_multiplier_for_market only ever touches status='active' legs,
-- so if a slip's legs are already all final, re-running it finds
-- nothing to do and silently no-ops — neither repair-multiplier-legs
-- nor a resolve() resume can fix this case at all.
--
-- This can happen when a slip's legs and the parent slip's own
-- resolved_outcome-driven state fall out of sync — e.g. a manual
-- direct-SQL settlement that updated multiplier_legs correctly but
-- didn't also carry through the slip-level status/counters/payout the
-- way settle_multiplier_for_market's own completion branch does.
--
-- Mirrors settle_multiplier_for_market's "did that complete the slip"
-- logic exactly (see 20260701000000_multi_outcome_resolve_and_resume.sql),
-- just triggered directly against the slip's CURRENT leg states instead
-- of being driven by a specific leg transitioning out of 'active'.

CREATE OR REPLACE FUNCTION public.finalize_stalled_slip(
  p_slip_id uuid
)
RETURNS TABLE (applied boolean, new_status text, payout_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_max_payout constant numeric := 200000;
  v_slip         record;
  v_leg_count    integer;
  v_active_count integer;
  v_lost_count   integer;
  v_won_count    integer;
  v_product      numeric;
  v_all_void     boolean;
  v_payout       numeric;
  v_tngn_payout  numeric;
  v_bonus_payout numeric;
BEGIN
  SELECT * INTO v_slip FROM public.multiplier_slips WHERE id = p_slip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_stalled_slip: slip % not found', p_slip_id USING ERRCODE = 'P0002';
  END IF;

  -- Already finalized (by this call, a prior call, or the normal path).
  -- Idempotent no-op — safe to call repeatedly / concurrently.
  IF v_slip.status <> 'active' THEN
    RETURN QUERY SELECT false, v_slip.status, v_slip.final_payout_tngn;
    RETURN;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'active'),
    COUNT(*) FILTER (WHERE status = 'lost'),
    COUNT(*) FILTER (WHERE status = 'won')
    INTO v_leg_count, v_active_count, v_lost_count, v_won_count
  FROM public.multiplier_legs
  WHERE slip_id = p_slip_id
  FOR UPDATE;

  IF v_leg_count = 0 THEN
    RAISE EXCEPTION 'finalize_stalled_slip: slip % has no legs at all' , p_slip_id USING ERRCODE = 'P0001';
  END IF;
  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'finalize_stalled_slip: slip % still has % active leg(s) — not ready to finalize, use repair-multiplier-legs instead', p_slip_id, v_active_count USING ERRCODE = 'P0001';
  END IF;

  IF v_lost_count > 0 THEN
    -- Slip lost. House keeps the whole net stake.
    UPDATE public.multiplier_slips
      SET status = 'lost',
          legs_resolved = v_leg_count,
          legs_won = v_won_count,
          final_payout_tngn = 0,
          settled_at = now()
    WHERE id = p_slip_id;

    PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn, NULL);

    INSERT INTO public.notifications (user_id, type, message)
    VALUES (v_slip.user_id, 'multiplier_lost',
            'One leg of your Multiplier didn''t land — better luck next slip.');

    RETURN QUERY SELECT true, 'lost'::text, 0::numeric;
    RETURN;
  END IF;

  -- No losses — every leg is won or void. Compute the completion the
  -- same way settle_multiplier_for_market does.
  SELECT
    COALESCE(EXP(SUM(LN(GREATEST(realized_odds, 0.0001)))), 1),
    BOOL_AND(status = 'void')
    INTO v_product, v_all_void
  FROM public.multiplier_legs
  WHERE slip_id = p_slip_id;

  v_payout := LEAST(c_max_payout, round(v_slip.net_slip_stake_tngn * v_product));

  IF v_all_void THEN
    v_tngn_payout  := round(v_slip.net_slip_stake_tngn * (1 - COALESCE(v_slip.bonus_proportion, 0)), 4);
    v_bonus_payout := v_slip.net_slip_stake_tngn - v_tngn_payout;

    UPDATE public.multiplier_slips
      SET status = 'voided',
          legs_resolved = v_leg_count,
          legs_won = v_won_count,
          final_payout_tngn = v_slip.net_slip_stake_tngn,
          settled_at = now()
    WHERE id = p_slip_id;

    PERFORM public.credit_user(v_slip.user_id, v_tngn_payout, v_bonus_payout);

    UPDATE public.boost_wallet
      SET balance = balance + 1, updated_at = now()
    WHERE user_id = v_slip.user_id;
    INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
    SELECT v_slip.user_id, 1, 'slip_refund', p_slip_id, balance
    FROM public.boost_wallet WHERE user_id = v_slip.user_id;

    INSERT INTO public.notifications (user_id, type, message, amount)
    VALUES (v_slip.user_id, 'multiplier_voided',
            'Your Multiplier was voided (all legs postponed). Stake and Boost refunded.',
            v_slip.net_slip_stake_tngn);

    RETURN QUERY SELECT true, 'voided'::text, v_slip.net_slip_stake_tngn;
    RETURN;
  END IF;

  -- Won. Apply the bonus winnings split then pay.
  SELECT tngn_amount, bonus_amount INTO v_tngn_payout, v_bonus_payout
  FROM public.bonus_winnings_split(v_payout, COALESCE(v_slip.bonus_proportion, 0));

  UPDATE public.multiplier_slips
    SET status = 'won',
        legs_resolved = v_leg_count,
        legs_won = v_won_count,
        final_payout_tngn = v_payout,
        settled_at = now()
  WHERE id = p_slip_id;

  PERFORM public.credit_user(v_slip.user_id, v_tngn_payout, v_bonus_payout);
  PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn - v_payout, NULL);

  INSERT INTO public.notifications (user_id, type, message, amount)
  VALUES (v_slip.user_id, 'multiplier_won',
          'Your Multiplier hit! ₦' || to_char(v_payout, 'FM999,999,999') || ' credited. 🎉',
          v_payout);

  UPDATE public.users
    SET points = COALESCE(points, 0) + GREATEST(0, floor((v_payout - v_slip.slip_stake_tngn) / 100)::int)
  WHERE id = v_slip.user_id;

  RETURN QUERY SELECT true, 'won'::text, v_payout;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_stalled_slip(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stalled_slip(uuid) TO service_role;

COMMENT ON FUNCTION public.finalize_stalled_slip IS
  'Finalizes a Multiplier slip whose legs are all already settled (won/lost/void) but the slip row itself is still active. Idempotent (no-ops if the slip is no longer active) and row-locked. Raises if the slip still has an active leg — that case belongs to repair-multiplier-legs / a normal resolve, not this function.';

NOTIFY pgrst, 'reload schema';
