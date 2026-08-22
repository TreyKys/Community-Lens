-- Notify on single-bet settlement.
--
-- settle_bet_outcome flipped a bet to won/lost and credited the wallet without
-- telling anyone. Multiplier slips have notified since 20260621020000, so the
-- inconsistency was invisible from the code and obvious to a user: settle a
-- slip and they hear about it, settle a single bet and they do not.
--
-- Resolution is the most important thing that happens to a bet, and it was
-- reaching the user only if they thought to go and check the Picks tab. The
-- amount goes in the message rather than a generic "your bet was settled" —
-- "You won ₦4,200" is a reason to open the app; "your prediction resolved" is
-- an errand.
--
-- The insert sits on the branch that ACTUALLY APPLIED the settlement, after
-- the early return for an already-settled bet, so a concurrent duplicate
-- resolve cannot produce a second notification any more than it can produce a
-- second payment.
--
-- Reproduced from 20260701010000 with only that insert added.

CREATE OR REPLACE FUNCTION public.settle_bet_outcome(
  p_bet_id      uuid,
  p_user_id     uuid,
  p_new_status  text,     -- 'won' or 'lost'
  p_payout_tngn numeric,  -- 0 for a loss
  p_tngn_delta  numeric,  -- 0 for a loss
  p_bonus_delta numeric   -- 0 for a loss
)
RETURNS boolean  -- true if this call applied the settlement; false if the
                 -- bet was already settled by an earlier/concurrent call
                 -- (idempotent no-op — caller should skip points/notify)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_new_status NOT IN ('won', 'lost') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_status FROM public.user_bets WHERE id = p_bet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bet_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Already settled by an earlier pass or a concurrent caller that won
  -- the row lock first. Safe no-op — this is what makes resuming a
  -- stuck resolution (and a genuinely concurrent duplicate request)
  -- idempotent instead of a double-pay.
  IF v_status <> 'active' THEN
    RETURN false;
  END IF;

  IF p_tngn_delta <> 0 OR p_bonus_delta <> 0 THEN
    PERFORM public.credit_user(p_user_id, p_tngn_delta, p_bonus_delta);
  END IF;

  UPDATE public.user_bets SET status = p_new_status, payout_tngn = p_payout_tngn WHERE id = p_bet_id;

  -- Tell them. This was the gap: a multiplier slip notified on settlement and
  -- a single bet did not, so the most important thing that happens to a bet —
  -- it resolving — reached the user only if they thought to go and look.
  --
  -- The AMOUNT is in the message, not just the fact. "Your prediction won" is
  -- a status update; "You won ₦4,200" is the reason to open the app.
  --
  -- Inside the same statement-level path as the settlement, and only on the
  -- branch that actually applied it, so a concurrent duplicate resolve cannot
  -- send a second copy.
  INSERT INTO public.notifications (user_id, type, message, amount, severity, action_url)
  SELECT p_user_id,
         CASE WHEN p_new_status = 'won' THEN 'bet_won' ELSE 'bet_lost' END,
         CASE WHEN p_new_status = 'won'
              THEN 'You won ₦' || to_char(p_payout_tngn, 'FM999,999,999') || ' on "'
                   || left(COALESCE(m.question, 'your prediction'), 60) || '"'
              ELSE 'No luck on "' || left(COALESCE(m.question, 'your prediction'), 60)
                   || '" — the answer went the other way'
         END,
         CASE WHEN p_new_status = 'won' THEN p_payout_tngn ELSE NULL END,
         CASE WHEN p_new_status = 'won' THEN 'success' ELSE 'info' END,
         '/bets'
    FROM public.user_bets b
    LEFT JOIN public.markets m ON m.id = b.market_id
   WHERE b.id = p_bet_id;

  RETURN true;
END;
$$;

NOTIFY pgrst, 'reload schema';
