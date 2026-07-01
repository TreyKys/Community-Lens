-- Multi-outcome resolution + resumable settlement.
--
-- Two independent fixes bundled together because both touch the same
-- resolve path:
--
-- 1. MULTI-OUTCOME RESOLVE
--    Admins can now resolve a market with more than one winning
--    outcome (ties, "either of these counts" rulings). markets gains
--    resolved_outcomes integer[] to record the full winning set;
--    resolved_outcome (existing single column) keeps holding the
--    first/primary index for anything still reading it. Every settle
--    function that used to compare against one winning index now
--    checks membership in the set.
--
-- 2. RESUMABLE SETTLEMENT
--    settle_multiplier_for_market already only touches status='active'
--    legs, so it was always safe to re-run — but its signature
--    (p_winning_outcome integer) can't express a tie. Replaced with
--    p_winning_outcomes integer[]. The TypeScript resolve route pairs
--    this with a resumable claim: a market whose resolution died
--    partway (some bets/legs settled, others still active, status
--    stuck at 'locked') can now be finished by simply re-POSTing the
--    same resolve request instead of being permanently stuck behind a
--    409.

ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS resolved_outcomes integer[];

-- ── settle_multiplier_for_market — accept a winning-outcome SET ──────

DROP FUNCTION IF EXISTS public.settle_multiplier_for_market(bigint, integer, boolean);

CREATE OR REPLACE FUNCTION public.settle_multiplier_for_market(
  p_market_id        bigint,
  p_winning_outcomes integer[],  -- null/empty when the market voided
  p_voided           boolean
)
RETURNS integer  -- number of legs processed
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
  v_tngn_payout  numeric;
  v_bonus_payout numeric;
  v_is_void      boolean;
BEGIN
  IF p_market_id IS NULL THEN
    RAISE EXCEPTION 'settle_multiplier_for_market: market_id null' USING ERRCODE = 'P0001';
  END IF;

  v_is_void := p_voided OR p_winning_outcomes IS NULL OR array_length(p_winning_outcomes, 1) IS NULL;

  -- Lock the active legs on this market. FOR UPDATE on the leg rows
  -- serialises against any concurrent settlement of the same market.
  FOR v_leg IN
    SELECT id, slip_id, outcome_index, locked_odds
    FROM public.multiplier_legs
    WHERE market_id = p_market_id AND status = 'active'
    FOR UPDATE
  LOOP
    -- Decide this leg's result.
    IF v_is_void THEN
      v_result := 'void';
      v_realized := 1.0;
    ELSIF v_leg.outcome_index = ANY(p_winning_outcomes) THEN
      v_result := 'won';
      v_realized := v_leg.locked_odds;
    ELSE
      v_result := 'lost';
      v_realized := NULL;
    END IF;

    UPDATE public.multiplier_legs
      SET status = v_result, realized_odds = v_realized, resolved_at = now()
    WHERE id = v_leg.id;

    v_processed := v_processed + 1;

    -- Lock the parent slip.
    SELECT * INTO v_slip FROM public.multiplier_slips
    WHERE id = v_leg.slip_id FOR UPDATE;

    -- Slip already settled (earlier lost leg, or already paid). Leave
    -- it; we only needed to stamp the leg above for the record.
    IF v_slip.status <> 'active' THEN
      CONTINUE;
    END IF;

    IF v_result = 'lost' THEN
      -- Slip dies now. House keeps the whole net stake.
      UPDATE public.multiplier_slips
        SET status = 'lost',
            legs_resolved = legs_resolved + 1,
            final_payout_tngn = 0,
            settled_at = now()
      WHERE id = v_slip.id;

      PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn, p_market_id);

      INSERT INTO public.notifications (user_id, type, message)
      VALUES (v_slip.user_id, 'multiplier_lost',
              'One leg of your Multiplier didn''t land — better luck next slip.');
      CONTINUE;
    END IF;

    -- Leg won or void. Advance the counters.
    UPDATE public.multiplier_slips
      SET legs_resolved = legs_resolved + 1,
          legs_won = legs_won + CASE WHEN v_result = 'won' THEN 1 ELSE 0 END
    WHERE id = v_slip.id;

    -- Did that complete the slip?
    IF v_slip.legs_resolved + 1 >= v_slip.legs_total THEN
      -- All legs in; none lost (a lost leg would have killed it above).
      -- Compute product across ALL legs' realized odds (void = 1.0).
      SELECT
        COALESCE(EXP(SUM(LN(GREATEST(realized_odds, 0.0001)))), 1),
        BOOL_AND(status = 'void')
        INTO v_product, v_all_void
      FROM public.multiplier_legs
      WHERE slip_id = v_slip.id;

      v_payout := LEAST(c_max_payout, round(v_slip.net_slip_stake_tngn * v_product));

      IF v_all_void THEN
        -- Void: refund proportional to original funding source.
        -- Bonus-funded portion returns to bonus; cash-funded to tngn.
        v_tngn_payout  := round(v_slip.net_slip_stake_tngn * (1 - COALESCE(v_slip.bonus_proportion, 0)), 4);
        v_bonus_payout := v_slip.net_slip_stake_tngn - v_tngn_payout;

        UPDATE public.multiplier_slips
          SET status = 'voided',
              final_payout_tngn = v_slip.net_slip_stake_tngn,
              settled_at = now()
        WHERE id = v_slip.id;

        PERFORM public.credit_user(v_slip.user_id, v_tngn_payout, v_bonus_payout);

        UPDATE public.boost_wallet
          SET balance = balance + 1, updated_at = now()
        WHERE user_id = v_slip.user_id;
        INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
        SELECT v_slip.user_id, 1, 'slip_refund', v_slip.id, balance
        FROM public.boost_wallet WHERE user_id = v_slip.user_id;

        INSERT INTO public.notifications (user_id, type, message, amount)
        VALUES (v_slip.user_id, 'multiplier_voided',
                'Your Multiplier was voided (all legs postponed). Stake and Boost refunded.',
                v_slip.net_slip_stake_tngn);
      ELSE
        -- Won. Apply bonus winnings split then pay.
        SELECT tngn_amount, bonus_amount INTO v_tngn_payout, v_bonus_payout
        FROM public.bonus_winnings_split(v_payout, COALESCE(v_slip.bonus_proportion, 0));

        UPDATE public.multiplier_slips
          SET status = 'won',
              final_payout_tngn = v_payout,
              settled_at = now()
        WHERE id = v_slip.id;

        PERFORM public.credit_user(v_slip.user_id, v_tngn_payout, v_bonus_payout);
        PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn - v_payout, p_market_id);

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

REVOKE ALL ON FUNCTION public.settle_multiplier_for_market(bigint, integer[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_multiplier_for_market(bigint, integer[], boolean) TO service_role;

COMMENT ON FUNCTION public.settle_multiplier_for_market IS
  'Trickle settlement for Multiplier slips, ties/multi-outcome aware. Called once per market resolution (and safe to re-call — only touches status=active rows, so a resumed resolve after a partial failure will not double-settle or double-pay). A losing leg kills its slip immediately; a winning/void leg advances the slip and, when it completes with no losses, pays net x product(realized odds) split by bonus_winnings_split(), capped at 200k. All-void slips refund the net stake AND the Boost, proportional to original cash/bonus funding.';

NOTIFY pgrst, 'reload schema';
