-- Phase 8 (brought forward): Boost purchase + all-void full refund.
--
-- 1. purchase_boosts — buy Boosts at ₦70 each, deducted from balance,
--    logged to treasury as 'boost_rake'.
-- 2. settle_multiplier_for_market — all-void slips now refund the GROSS
--    stake (not net) plus the Boost, so a fully-postponed slip costs the
--    user nothing. The reserve absorbs the small refunded entry rake.

-- ── purchase_boosts ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purchase_boosts(
  p_user_id  uuid,
  p_quantity integer
)
RETURNS TABLE (
  boosts_balance     integer,
  new_tngn_balance   numeric,
  new_bonus_balance  numeric,
  cost_tngn          numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_price_each   constant numeric := 70;
  c_max_per_buy  constant integer := 20;
  v_cost     numeric;
  v_real     numeric;
  v_bonus    numeric;
  v_new_real numeric;
  v_new_bonus numeric;
  v_balance  integer;
BEGIN
  IF p_user_id IS NULL OR p_quantity IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF p_quantity < 1 OR p_quantity > c_max_per_buy THEN
    RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = 'P0001';
  END IF;

  v_cost := c_price_each * p_quantity;

  -- Lock user + balance.
  SELECT tngn_balance, bonus_balance INTO v_real, v_bonus
  FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_real := COALESCE(v_real, 0);
  v_bonus := COALESCE(v_bonus, 0);
  IF v_real + v_bonus < v_cost THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
  END IF;

  -- Deduct real first, then bonus (same order as staking).
  IF v_real >= v_cost THEN
    v_new_real := v_real - v_cost;
    v_new_bonus := v_bonus;
  ELSE
    v_new_real := 0;
    v_new_bonus := v_bonus - (v_cost - v_real);
  END IF;

  UPDATE public.users
    SET tngn_balance = v_new_real,
        bonus_balance = GREATEST(v_new_bonus, 0)
  WHERE id = p_user_id;

  -- Credit the Boosts.
  PERFORM public.ensure_boost_wallet(p_user_id);
  UPDATE public.boost_wallet
    SET balance = balance + p_quantity,
        lifetime_granted = lifetime_granted + p_quantity,
        updated_at = now()
  WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.boost_ledger (user_id, delta, reason, balance_after)
  VALUES (p_user_id, p_quantity, 'purchase', v_balance);

  -- Revenue to treasury.
  INSERT INTO public.treasury_log (type, amount_tngn, user_id, created_at)
  VALUES ('boost_rake', v_cost, p_user_id, now());

  RETURN QUERY SELECT v_balance, v_new_real, GREATEST(v_new_bonus, 0), v_cost;
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_boosts(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_boosts(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.purchase_boosts IS
  'Buy Boosts at ₦70 each (max 20/purchase). Deducts from balance (real first, then bonus), credits the Boost wallet, logs revenue to treasury_log as boost_rake.';

-- ── settle_multiplier_for_market — all-void refunds GROSS + Boost ────
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
      UPDATE public.multiplier_slips
        SET status = 'lost', legs_resolved = legs_resolved + 1,
            final_payout_tngn = 0, settled_at = now()
      WHERE id = v_slip.id;
      PERFORM public.apply_house_pnl(v_slip.net_slip_stake_tngn, p_market_id);
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
        -- Full refund of the GROSS stake (entry rake included) + Boost.
        -- The reserve absorbs the small refunded entry rake so the
        -- user is made whole on a fully-postponed slip.
        UPDATE public.multiplier_slips
          SET status = 'voided',
              final_payout_tngn = v_slip.slip_stake_tngn,
              settled_at = now()
        WHERE id = v_slip.id;

        PERFORM public.credit_user(v_slip.user_id, v_slip.slip_stake_tngn, 0);
        -- reserve eats the entry rake we'd logged at placement.
        PERFORM public.apply_house_pnl(-(v_slip.slip_stake_tngn - v_slip.net_slip_stake_tngn), p_market_id);

        UPDATE public.boost_wallet SET balance = balance + 1, updated_at = now()
        WHERE user_id = v_slip.user_id;
        INSERT INTO public.boost_ledger (user_id, delta, reason, slip_id, balance_after)
        SELECT v_slip.user_id, 1, 'slip_refund', v_slip.id, balance
        FROM public.boost_wallet WHERE user_id = v_slip.user_id;

        INSERT INTO public.notifications (user_id, type, message, amount)
        VALUES (v_slip.user_id, 'multiplier_voided',
                'Your Multiplier was voided (all legs postponed). Stake and Boost refunded in full.',
                v_slip.slip_stake_tngn);
      ELSE
        UPDATE public.multiplier_slips
          SET status = 'won', final_payout_tngn = v_payout, settled_at = now()
        WHERE id = v_slip.id;
        PERFORM public.credit_user(v_slip.user_id, v_payout, 0);
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

NOTIFY pgrst, 'reload schema';
