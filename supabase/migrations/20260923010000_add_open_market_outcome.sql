-- Add a new outcome to a LIVE Open Market — a new candidate enters a race, a
-- new team qualifies, a new name enters a BBN cast — without closing the
-- book and relaunching it as a separate market (which would fragment
-- liquidity and lose every existing trader's position).
--
-- The LMSR math: for an existing book with cost C(q_old) = b·ln(Σ exp(qi/b)),
-- appending a new outcome at quantity q_new gives it opening price
--   p = exp(q_new/b) / (Σ exp(qi_old/b) + exp(q_new/b))
-- Solving for q_new against a CHOSEN opening price p:
--   exp(q_new/b) = exp(C(q_old)/b) · p/(1-p)      [since exp(C(q_old)/b) = Σ exp(qi_old/b)]
--   q_new = C(q_old) + b·ln(p/(1-p))
-- which is exactly what's below, computed from the existing lmsr_cost()
-- rather than re-derived. The effect: every EXISTING outcome's price scales
-- down by the uniform factor (1-p) — their relative odds to each other are
-- completely unchanged — and the new outcome opens at exactly p. Nobody's
-- position moves relative to any other existing outcome.
--
-- q_initial gets the SAME appended value, not zero. verify_open_market_book's
-- book_matches_holdings check requires q[i] - q_initial[i] to equal shares
-- actually held at i — zero, since nobody has traded the new outcome yet.
-- Checked by hand against the other three money invariants before this was
-- applied anywhere: wallets_paid_at_least_the_curve and
-- payouts_within_cash_in_plus_subsidy both compare against a value that
-- appending a matching (q, q_initial) pair only ever makes MORE permissive,
-- never less — a new outcome the house is contributing zero net q movement
-- for cannot tighten either bound.
--
-- Fleet exposure: adding an outcome raises this market's own worst case
-- (b·ln(N)) — real committed exposure whether or not the new side ever
-- trades — so this re-runs the exact same fleet-wide cap check
-- review_open_market applies at approval, and updates threshold_tngn (the
-- creator's fee-share threshold, stored equal to worst-case by design — see
-- that function) to match the new N.

CREATE TABLE IF NOT EXISTS public.open_market_outcome_additions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id     uuid NOT NULL REFERENCES public.open_markets(id) ON DELETE CASCADE,
  outcome_idx   integer NOT NULL,
  label         text NOT NULL,
  initial_price numeric NOT NULL,
  added_by      uuid REFERENCES public.users(id),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS open_market_outcome_additions_market_idx
  ON public.open_market_outcome_additions (market_id, created_at DESC);

ALTER TABLE public.open_market_outcome_additions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS open_market_outcome_additions_service ON public.open_market_outcome_additions;
CREATE POLICY open_market_outcome_additions_service ON public.open_market_outcome_additions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP FUNCTION IF EXISTS public.add_open_market_outcome(uuid,text,numeric,uuid,text);

CREATE OR REPLACE FUNCTION public.add_open_market_outcome(
  p_market_id     uuid,
  p_label         text,
  p_initial_price numeric,   -- 0 < p < 1 — the new outcome's opening price
  p_admin_id      uuid,
  p_reason        text DEFAULT NULL,
  p_dry_run       boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, outcome_idx integer, new_prices numeric[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt       public.open_markets%ROWTYPE;
  v_cfg       public.open_markets_config%ROWTYPE;
  v_label     text;
  v_n_old     integer;
  v_n_new     integer;
  v_q_new     numeric;
  v_worst_new numeric;
  v_committed numeric;
  v_real_fees numeric;
  v_q_full    numeric[];
BEGIN
  IF p_admin_id IS NULL THEN
    RETURN QUERY SELECT false, 'admin identity required', NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found', NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  -- Only a LIVE, actively-trading book. There is no one left to trade the
  -- new side once trading has stopped (closed/pending_payout/resolved/
  -- voided/retired), and doing this mid-review or mid-horizon-decision is a
  -- different problem this does not try to solve.
  IF v_mkt.status <> 'open' THEN
    RETURN QUERY SELECT false, 'market must be open (status=' || v_mkt.status || ')',
                        NULL::integer, NULL::numeric[];
    RETURN;
  END IF;
  IF v_mkt.halted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'halted', NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  v_label := btrim(COALESCE(p_label, ''));
  IF v_label = '' THEN
    RETURN QUERY SELECT false, 'Name the new outcome', NULL::integer, NULL::numeric[];
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_mkt.outcomes) o WHERE lower(btrim(o)) = lower(v_label)) THEN
    RETURN QUERY SELECT false, 'That outcome already exists', NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  v_n_old := array_length(v_mkt.outcomes, 1);
  v_n_new := v_n_old + 1;
  -- Same ceiling submit_open_market enforces at submission time.
  IF v_n_new > 30 THEN
    RETURN QUERY SELECT false, 'A market cannot hold more than 30 outcomes',
                        NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  IF p_initial_price IS NULL OR p_initial_price <= 0 OR p_initial_price >= 1 THEN
    RETURN QUERY SELECT false, 'Initial price must be between 0% and 100%, exclusive',
                        NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  v_q_new := public.lmsr_cost(v_mkt.q, v_mkt.b)
             + v_mkt.b * ln(p_initial_price / (1 - p_initial_price));

  v_worst_new := v_mkt.b * ln(v_n_new::numeric);

  -- Same fleet-wide cap review_open_market checks at approval.
  SELECT COALESCE(SUM(b * ln(COALESCE(array_length(outcomes,1),2)::numeric)), 0)
    INTO v_committed
    FROM public.open_markets
   WHERE status IN ('open','horizon_window','halted','pending_payout')
     AND id <> p_market_id;
  SELECT * INTO v_cfg FROM public.open_markets_config WHERE id = 1;
  IF v_committed + v_worst_new > COALESCE(v_cfg.max_total_exposure_tngn, 500000) THEN
    RETURN QUERY SELECT false,
      'Would push fleet exposure to ' || round(v_committed + v_worst_new)
        || ', above the ' || round(COALESCE(v_cfg.max_total_exposure_tngn, 500000)) || ' cap.',
      NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  -- Raising threshold_tngn is the whole point (it IS the market's worst
  -- case, by design — see review_open_market), but verify_open_market_book's
  -- creator_accrual_within_replay check compares creator_accrued against
  -- 25% of (real fees − threshold). A market that already earned real
  -- accrual under the OLD, lower threshold could have that accrual exceed
  -- what the NEW, higher threshold allows — not a bug in either check, just
  -- two correct rules in tension. Caught in testing, not theoretical:
  -- replay the exact same formula here and refuse up front rather than
  -- silently create a book that fails its own invariant and gets stuck
  -- unable to settle later, discovered only at that far less convenient
  -- moment.
  SELECT COALESCE(SUM(t.fee_tngn * t.paid_cash / NULLIF(t.paid_cash + t.paid_bonus, 0)), 0)
    INTO v_real_fees
    FROM public.open_trades t WHERE t.market_id = p_market_id;
  IF v_mkt.creator_accrued > 0.25 * GREATEST(v_real_fees - v_worst_new, 0) + 0.01 THEN
    RETURN QUERY SELECT false,
      'This market has already accrued ₦' || round(v_mkt.creator_accrued)
        || ' to its creator under the current threshold — raising it for a new '
        || 'outcome would leave that over the new allowance. Settle or reconcile '
        || 'creator accrual before adding an outcome here.',
      NULL::integer, NULL::numeric[];
    RETURN;
  END IF;

  v_q_full := v_mkt.q || v_q_new;

  IF p_dry_run THEN
    RETURN QUERY SELECT false, 'dry_run', v_n_new - 1, public.lmsr_prices(v_q_full, v_mkt.b);
    RETURN;
  END IF;

  UPDATE public.open_markets
     SET outcomes       = v_mkt.outcomes || v_label,
         q              = v_q_full,
         q_initial      = v_mkt.q_initial || v_q_new,
         threshold_tngn = v_worst_new
   WHERE id = p_market_id;

  INSERT INTO public.open_market_outcome_additions
    (market_id, outcome_idx, label, initial_price, added_by, reason)
  VALUES (p_market_id, v_n_new - 1, v_label, p_initial_price, p_admin_id,
          NULLIF(btrim(COALESCE(p_reason, '')), ''));

  RETURN QUERY SELECT true, 'added', v_n_new - 1, public.lmsr_prices(v_q_full, v_mkt.b);
END;
$$;

REVOKE ALL ON FUNCTION public.add_open_market_outcome(uuid,text,numeric,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_open_market_outcome(uuid,text,numeric,uuid,text,boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
