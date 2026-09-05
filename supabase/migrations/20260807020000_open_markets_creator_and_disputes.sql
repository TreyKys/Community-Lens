-- Creator earnings and user disputes.
--
-- Two things the engine could account for but nobody could actually DO: a
-- creator had earnings accrue with no way to take them, and a user who thought
-- a resolution was wrong had nowhere to say so before the money released.

-- ── Claim creator earnings ─────────────────────────────────────────────────
-- Creators take 25% of house fees, but only on fees accrued AFTER cumulative
-- fees pass b*ln(N) — the house recovers its entire maximum exposure before a
-- naira is shared.
CREATE OR REPLACE FUNCTION public.claim_creator_earnings(
  p_market_id uuid,
  p_user_id   uuid
)
RETURNS TABLE (applied boolean, reason text, paid_tngn numeric, remaining_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt    public.open_markets%ROWTYPE;
  v_owed   numeric;
  v_replay numeric;
  v_fees   numeric;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Sign in first', 0::numeric, 0::numeric; RETURN;
  END IF;

  -- Locked for the same reason every money path here is: two taps on a slow
  -- connection must not pay the same earnings twice.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found', 0::numeric, 0::numeric; RETURN;
  END IF;
  IF v_mkt.created_by IS NULL OR v_mkt.created_by <> p_user_id THEN
    RETURN QUERY SELECT false, 'This is not your market', 0::numeric, 0::numeric; RETURN;
  END IF;

  v_owed := COALESCE(v_mkt.creator_accrued,0) - COALESCE(v_mkt.creator_paid,0);
  IF v_owed <= 0 THEN
    RETURN QUERY SELECT false,
      CASE WHEN COALESCE(v_mkt.creator_accrued,0) = 0
           THEN 'Nothing earned yet — this market has not passed its threshold'
           ELSE 'Everything earned so far has been paid' END,
      0::numeric, 0::numeric;
    RETURN;
  END IF;

  -- creator_accrued is a running total maintained on the trade path. It is a
  -- cache, and a cache is exactly the thing not to trust when paying out, so
  -- it is replayed from the trade log before any money moves. Paying the
  -- LESSER of the two means a corrupted counter under-pays (recoverable) and
  -- never over-pays (not recoverable).
  SELECT COALESCE(SUM(fee_tngn),0) INTO v_fees
    FROM public.open_trades WHERE market_id = p_market_id;
  v_replay := 0.25 * GREATEST(v_fees - COALESCE(v_mkt.threshold_tngn,0), 0);

  IF COALESCE(v_mkt.creator_accrued,0) > v_replay + 0.01 THEN
    v_owed := GREATEST(LEAST(v_owed, v_replay - COALESCE(v_mkt.creator_paid,0)), 0);
    IF v_owed <= 0 THEN
      RETURN QUERY SELECT false,
        'Earnings are under review — the recorded total does not match the fee history',
        0::numeric, 0::numeric;
      RETURN;
    END IF;
  END IF;

  v_owed := floor(v_owed * 100) / 100;   -- residual stays with the house
  IF v_owed <= 0 THEN
    RETURN QUERY SELECT false, 'Too small to pay out yet', 0::numeric,
      COALESCE(v_mkt.creator_accrued,0) - COALESCE(v_mkt.creator_paid,0);
    RETURN;
  END IF;

  -- Market lock is held, user lock is taken after it — the same order
  -- execute_open_trade uses, so these can never deadlock against each other.
  -- credit_user is safe here because this is a CREDIT; its clamp at zero is
  -- only unsound as a debit.
  PERFORM public.credit_user(p_user_id, v_owed, 0);

  UPDATE public.open_markets
     SET creator_paid = COALESCE(creator_paid,0) + v_owed
   WHERE id = p_market_id;

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, open_market_id, metadata)
  VALUES ('open_market_creator_payout', -v_owed, p_user_id, p_market_id,
          jsonb_build_object('fees_at_payout', v_fees,
                             'threshold', v_mkt.threshold_tngn));

  INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
  VALUES (p_user_id, 'open_market_creator_payout',
          'Creator earnings paid: ₦' || to_char(v_owed, 'FM999,999,999.00'),
          v_owed, 'success', '/open/creator');

  RETURN QUERY SELECT true, 'paid', v_owed,
    COALESCE((SELECT creator_accrued - creator_paid FROM public.open_markets
               WHERE id = p_market_id), 0);
END;
$$;


-- ── Raise a dispute ────────────────────────────────────────────────────────
-- Only meaningful DURING the dispute window: once payouts release, money is in
-- withdrawable balances and cannot be clawed back. An open dispute blocks
-- release, which is what gives the button teeth.
CREATE OR REPLACE FUNCTION public.raise_open_market_dispute(
  p_market_id uuid,
  p_user_id   uuid,
  p_reason    text
)
RETURNS TABLE (applied boolean, reason text, dispute_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt public.open_markets%ROWTYPE;
  v_id  uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Sign in first', NULL::uuid; RETURN;
  END IF;
  IF length(btrim(COALESCE(p_reason,''))) < 15 THEN
    RETURN QUERY SELECT false, 'Say what you think is wrong, in a sentence or two', NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found', NULL::uuid; RETURN;
  END IF;

  -- Only people with money in it. Otherwise a dispute is a free lever anyone
  -- can pull to freeze someone else's payout.
  IF NOT EXISTS (SELECT 1 FROM public.open_positions
                  WHERE market_id = p_market_id AND user_id = p_user_id
                    AND (shares_cash + shares_bonus) > 0)
     AND NOT EXISTS (SELECT 1 FROM public.open_trades
                      WHERE market_id = p_market_id AND user_id = p_user_id) THEN
    RETURN QUERY SELECT false, 'Only people who traded this market can dispute it', NULL::uuid;
    RETURN;
  END IF;

  IF v_mkt.status NOT IN ('pending_payout','resolved','voided') THEN
    RETURN QUERY SELECT false, 'This market has not been resolved yet', NULL::uuid; RETURN;
  END IF;

  -- After release there is nothing left to hold back.
  IF v_mkt.settlement_locked_until IS NULL OR now() >= v_mkt.settlement_locked_until THEN
    RETURN QUERY SELECT false,
      'The window for disputing this result has closed. Contact support instead.',
      NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.open_market_disputes (market_id, user_id, reason)
  VALUES (p_market_id, p_user_id, btrim(p_reason))
  ON CONFLICT (market_id, user_id) WHERE status = 'open' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT false, 'You already have an open dispute on this market', NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.notifications (user_id, type, message, severity, action_url)
  VALUES (NULL, 'admin_alert',
          'Open Markets dispute raised on: ' || left(v_mkt.question, 80),
          'warning', '/admin/open-markets/resolve');

  RETURN QUERY SELECT true, 'raised', v_id;
END;
$$;


-- ── What a creator needs to see about their own markets ────────────────────
-- DROP then CREATE, not CREATE OR REPLACE — same reasoning as
-- open_markets_review_queue below: nothing else currently redefines this
-- view, but CREATE OR REPLACE VIEW is a trap the moment anything ever does,
-- and DROP+CREATE costs nothing extra since only the creator summary route
-- reads it.
DROP VIEW IF EXISTS public.open_markets_creator_summary;
CREATE VIEW public.open_markets_creator_summary AS
SELECT
  m.id, m.question, m.category, m.outcomes, m.status, m.created_by,
  m.created_at, m.opened_at, m.resolved_at,
  m.review_score, m.review_notes,
  m.b, m.threshold_tngn, m.fees_collected,
  m.creator_accrued, m.creator_paid,
  (COALESCE(m.creator_accrued,0) - COALESCE(m.creator_paid,0)) AS claimable_tngn,
  m.trading_closes_at, m.horizon_at,
  (SELECT count(DISTINCT t.user_id) FROM public.open_trades t
    WHERE t.market_id = m.id)                                  AS traders,
  (SELECT count(*) FROM public.open_trades t
    WHERE t.market_id = m.id)                                  AS trades
FROM public.open_markets m;

REVOKE ALL ON public.open_markets_creator_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.open_markets_creator_summary TO service_role;

REVOKE ALL ON FUNCTION public.claim_creator_earnings(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_creator_earnings(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.raise_open_market_dispute(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_open_market_dispute(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
