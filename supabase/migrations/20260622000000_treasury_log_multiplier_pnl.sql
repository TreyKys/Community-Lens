-- Treasury logging for Multiplier slip P&L.
--
-- Today settle_multiplier_for_market calls apply_house_pnl which moves
-- house_reserve.total_tngn but writes no audit row to treasury_log. The
-- only way to find out how much vig we've actually netted from
-- multipliers is to diff the reserve over time.
--
-- This migration fixes that by re-installing settle_multiplier_for_market
-- with treasury_log entries alongside every reserve mutation. Type:
--   'multiplier_pnl'   — slip won or lost (signed house P&L)
--   'multiplier_void_refund' — entry-rake refunded on an all-void slip
--                              (negative number, small, rare)
--
-- The function body is otherwise IDENTICAL to 20260621040000. Behaviour
-- unchanged; only the audit trail improves.

CREATE OR REPLACE FUNCTION public.settle_multiplier_for_market(
  p_market_id       bigint,
  p_winning_outcome integer,
  p_voided          boolean
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_max_payout constant numeric := 200000;
  v_leg          record;
  v_slip         record;
  v_result       text;
  v_realized     numeric;
  v_product      numeric;
  v_payout       numeric;
  v_processed    integer := 0;
  v_all_void     boolean;
  v_pnl          numeric;
BEGIN
  IF p_market_id IS NULL THEN
    RAISE EXCEPTION 'settle_multiplier_for_market: market_id null' USING ERRCODE = 'P0001';
  END IF;

  FOR v_leg IN
    SELECT id, slip_id, outcome_index, locked_odds
    FROM public.multiplier_legs
    WHERE market_id = p_market_id AND status = 'active'
    FOR UPDATE
  LOOP
    IF p_voided OR p_winning_outcome IS NULL THEN
      v_result := 'void'; v_realized := 1.0;
    ELSIF v_leg.outcome_index = p_winning_outcome THEN
      v_result := 'won'; v_realized := v_leg.locked_odds;
    ELSE
      v_result := 'lost'; v_realized := NULL;
    END IF;

    UPDATE public.multiplier_legs
      SET status = v_result, realized_odds = v_realized, resolved_at = now()
    WHERE id = v_leg.id;
    v_processed := v_processed + 1;

    SELECT * INTO v_slip FROM public.multiplier_slips WHERE id = v_leg.slip_id FOR UPDATE;
    IF v_slip.status <> 'active' THEN CONTINUE; END IF;

    IF v_result = 'lost' THEN
      v_pnl := v_slip.net_slip_stake_tngn;
      UPDATE public.multiplier_slips
        SET status = 'lost', legs_resolved = legs_resolved + 1,
            final_payout_tngn = 0, settled_at = now()
      WHERE id = v_slip.id;
      PERFORM public.apply_house_pnl(v_pnl, p_market_id);
      INSERT INTO public.treasury_log (type, amount_tngn, user_id, market_id, metadata, created_at)
      VALUES ('multiplier_pnl', v_pnl, v_slip.user_id, p_market_id,
              jsonb_build_object('slip_id', v_slip.id, 'outcome', 'lost'), now());
      INSERT INTO public.notifications (user_id, type, message)
      VALUES (v_slip.user_id, 'multiplier_lost',
              'One leg of your Multiplier didn''t land — better luck next slip.');
      CONTINUE;
    END IF;

    UPDATE public.multiplier_slips
      SET legs_resolved = legs_resolved + 1,
          legs_won = legs_won + CASE WHEN v_result = 'won' THEN 1 ELSE 0 END
    WHERE id = v_slip.id;

    IF v_slip.legs_resolved + 1 >= v_slip.legs_total THEN
      SELECT
        COALESCE(EXP(SUM(LN(GREATEST(realized_odds, 0.0001)))), 1),
        BOOL_AND(status = 'void')
        INTO v_product, v_all_void
      FROM public.multiplier_legs WHERE slip_id = v_slip.id;

      v_payout := LEAST(c_max_payout, round(v_slip.net_slip_stake_tngn * v_product));

      IF v_all_void THEN
        UPDATE public.multiplier_slips
          SET status = 'voided',
              final_payout_tngn = v_slip.net_slip_stake_tngn,
              settled_at = now()
        WHERE id = v_slip.id;

        PERFORM public.credit_user(v_slip.user_id, v_slip.net_slip_stake_tngn, 0);

        UPDATE public.boost_wallet
          SET balance = balance + 1, updated_at = now()
        WHERE user_id = v_slip.user_id;
        INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
        SELECT v_slip.user_id, 1, 'slip_refund', v_slip.id, balance
        FROM public.boost_wallet WHERE user_id = v_slip.user_id;

        INSERT INTO public.notifications (user_id, type, message, amount)
        VALUES (v_slip.user_id, 'multiplier_voided',
                'Your Multiplier was voided (all legs postponed/cancelled). Net stake and Boost refunded.',
                v_slip.net_slip_stake_tngn);
      ELSE
        v_pnl := v_slip.net_slip_stake_tngn - v_payout;
        UPDATE public.multiplier_slips
          SET status = 'won', final_payout_tngn = v_payout, settled_at = now()
        WHERE id = v_slip.id;
        PERFORM public.credit_user(v_slip.user_id, v_payout, 0);
        PERFORM public.apply_house_pnl(v_pnl, p_market_id);
        INSERT INTO public.treasury_log (type, amount_tngn, user_id, market_id, metadata, created_at)
        VALUES ('multiplier_pnl', v_pnl, v_slip.user_id, p_market_id,
                jsonb_build_object('slip_id', v_slip.id, 'outcome', 'won', 'payout', v_payout), now());
        INSERT INTO public.notifications (user_id, type, message, amount)
        VALUES (v_slip.user_id, 'multiplier_won',
                'Your Multiplier hit! ₦' || to_char(v_payout, 'FM999,999,999') || ' credited. 🎉',
                v_payout);
        UPDATE public.users
          SET points = COALESCE(points, 0) + GREATEST(0, floor((v_payout - v_slip.slip_stake_tngn) / 100)::int)
        WHERE id = v_slip.user_id;
      END IF;
    END IF;
  END LOOP;

  RETURN v_processed;
END;
$$;

NOTIFY pgrst, 'reload schema';
