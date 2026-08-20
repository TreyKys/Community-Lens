-- Close the house-market accountability hole.
--
-- Every insider guard in this engine keyed off `created_by`. A HOUSE market —
-- one submitted by an admin with no creator attached, so no fee share accrues
-- — has created_by NULL, which meant all three guards fell open at once:
--
--   * review_open_market   "you cannot review your own market"  -> passed
--   * execute_open_trade   "creators cannot trade their own"    -> passed
--   * settle_open_market   "creator cannot resolve their own"   -> passed
--
-- So one admin could submit a market, approve it alone, trade it, and then
-- choose the winning outcome. The entire loop, with the result in their gift
-- and no second signature anywhere. On a real-money platform that is insider
-- trading, and it leaves no trace precisely because nothing refuses it.
--
-- It was not even obscure: creating a house market is the natural way to test
-- the engine, because it is the one configuration a single person can drive
-- end to end. That convenience WAS the hole.
--
-- The fix separates two ideas that had been conflated:
--
--   created_by   = who EARNS from it   (NULL on a house market, correctly)
--   submitted_by = who PUT IT THERE    (never NULL, and now always checked)
--
-- Four eyes then holds regardless of whether anyone is being paid a share.
-- Nothing changes for user-submitted markets: submitted_by defaults to
-- created_by, so the same person is caught by both checks.

ALTER TABLE public.open_markets
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS open_markets_submitted_by_idx
  ON public.open_markets (submitted_by) WHERE submitted_by IS NOT NULL;

-- Backfill: every existing row's submitter is its creator, which is true for
-- every user submission and the safest assumption for anything else.
UPDATE public.open_markets
   SET submitted_by = created_by
 WHERE submitted_by IS NULL AND created_by IS NOT NULL;

-- Signature changes by one defaulted parameter, so the old overload has to go
-- or named-argument calls become ambiguous — same trap as 20260807030000.
DROP FUNCTION IF EXISTS public.submit_open_market(
  uuid, text, text, text, text[], text, text, timestamptz, timestamptz, text
);

CREATE OR REPLACE FUNCTION public.submit_open_market(
  p_created_by        uuid,
  p_question          text,
  p_description       text,
  p_category          text,
  p_outcomes          text[],
  p_resolution_source text,
  p_resolution_detail text DEFAULT NULL,
  p_horizon_at        timestamptz DEFAULT NULL,
  p_trading_closes_at timestamptz DEFAULT NULL,
  p_event_tag         text DEFAULT NULL,
  p_submitted_by      uuid DEFAULT NULL
)
RETURNS TABLE (applied boolean, reason text, market_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.open_markets_config%ROWTYPE;
  v_n   integer;
  v_id  uuid;
  v_open_submissions integer;
BEGIN
  SELECT * INTO v_cfg FROM public.open_markets_config WHERE id = 1;
  IF NOT COALESCE(v_cfg.trading_enabled, false) THEN
    RETURN QUERY SELECT false, 'Open Markets are paused', NULL::uuid; RETURN;
  END IF;

  v_n := COALESCE(array_length(p_outcomes, 1), 0);
  IF v_n < 2 OR v_n > 8 THEN
    RETURN QUERY SELECT false, 'A market needs between 2 and 8 outcomes', NULL::uuid; RETURN;
  END IF;
  -- Duplicate labels make the resolved outcome ambiguous at payout time, and
  -- the constraint that would have caught it (q length) passes happily.
  IF (SELECT count(DISTINCT lower(btrim(o))) FROM unnest(p_outcomes) o) <> v_n THEN
    RETURN QUERY SELECT false, 'Outcomes must all be different', NULL::uuid; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_outcomes) o WHERE btrim(o) = '') THEN
    RETURN QUERY SELECT false, 'Outcomes cannot be blank', NULL::uuid; RETURN;
  END IF;
  IF length(btrim(COALESCE(p_question, ''))) < 15 THEN
    RETURN QUERY SELECT false, 'The question is too short to be unambiguous', NULL::uuid; RETURN;
  END IF;
  IF length(btrim(COALESCE(p_resolution_source, ''))) < 3 THEN
    RETURN QUERY SELECT false, 'Name the source that will settle this', NULL::uuid; RETURN;
  END IF;
  IF NOT (lower(btrim(p_category)) = ANY (v_cfg.allowed_categories)) THEN
    RETURN QUERY SELECT false, 'That category is not open for submissions yet', NULL::uuid; RETURN;
  END IF;
  IF p_trading_closes_at IS NOT NULL AND p_trading_closes_at <= now() THEN
    RETURN QUERY SELECT false, 'The closing time is already in the past', NULL::uuid; RETURN;
  END IF;

  -- Queue flooding is a denial-of-service on the reviewers' attention, which
  -- is the scarcest resource in this whole design.
  SELECT count(*) INTO v_open_submissions FROM public.open_markets
   WHERE created_by = p_created_by AND status IN ('pending_review','revise');
  IF v_open_submissions >= 3 THEN
    RETURN QUERY SELECT false, 'You already have 3 markets awaiting review', NULL::uuid; RETURN;
  END IF;

  INSERT INTO public.open_markets (
    question, description, category, outcomes,
    resolution_source, resolution_detail,
    b, q, q_initial, status,
    horizon_at, trading_closes_at, created_by, event_tag, submitted_by
  ) VALUES (
    btrim(p_question), NULLIF(btrim(COALESCE(p_description,'')), ''),
    lower(btrim(p_category)),
    ARRAY(SELECT btrim(o) FROM unnest(p_outcomes) o),
    btrim(p_resolution_source), NULLIF(btrim(COALESCE(p_resolution_detail,'')), ''),
    -- Placeholder only. b > 0 is a NOT NULL CHECK, and the real value is
    -- stamped at approval from the tier.
    10000,
    array_fill(0::numeric, ARRAY[v_n]), array_fill(0::numeric, ARRAY[v_n]),
    'pending_review',
    p_horizon_at, p_trading_closes_at, p_created_by,
    NULLIF(lower(btrim(COALESCE(p_event_tag,''))), ''),
    -- Falls back to the creator so a user submission is always attributed
    -- even when the caller does not pass this explicitly.
    COALESCE(p_submitted_by, p_created_by)
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT true, 'submitted', v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_open_market(
  p_market_id         uuid,
  p_reviewer_id       uuid,
  p_decision          text,             -- 'approve' | 'revise' | 'reject'
  p_score             smallint DEFAULT NULL,
  p_scores            jsonb    DEFAULT NULL,
  p_hard_gate         text     DEFAULT NULL,
  p_notes             text     DEFAULT NULL,
  p_tier              text     DEFAULT NULL,   -- approve only
  p_trading_closes_at timestamptz DEFAULT NULL,
  p_horizon_at        timestamptz DEFAULT NULL,
  p_dispute_window_hours smallint DEFAULT NULL
)
RETURNS TABLE (applied boolean, reason text, new_status text,
               b_tngn numeric, threshold_tngn numeric, worst_case_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt   public.open_markets%ROWTYPE;
  v_cfg   public.open_markets_config%ROWTYPE;
  v_n     integer;
  v_b     numeric;
  v_thr   numeric;
  v_worst numeric;
  v_committed numeric;
  v_closes timestamptz;
  v_horizon timestamptz;
BEGIN
  IF p_decision NOT IN ('approve','revise','reject') THEN
    RETURN QUERY SELECT false, 'Unknown decision', NULL::text, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- A NULL reviewer would sail straight through the four-eyes check below
  -- (`created_by = NULL` is NULL, not true) and leave the audit row unsigned.
  -- Admin auth on this platform is a shared secret, so the reviewer identity
  -- has to be supplied explicitly — refusing NULL is what makes it mandatory.
  IF p_reviewer_id IS NULL THEN
    RETURN QUERY SELECT false, 'Reviewer identity required', NULL::text,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  SELECT * INTO v_cfg FROM public.open_markets_config WHERE id = 1;

  -- Lock the row. Two admins opening the queue at once is the normal case, not
  -- the exotic one, and approving twice would open a market that is already
  -- open — re-stamping opened_at and threshold_tngn on a book that may already
  -- have trades in it.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Market not found', NULL::text, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;
  IF v_mkt.status NOT IN ('pending_review','revise') THEN
    RETURN QUERY SELECT false, 'This market has already been decided (' || v_mkt.status || ')',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- Four eyes. The creator approving their own market defeats the entire gate,
  -- and an admin who submits markets is exactly who this protects against.
  IF v_mkt.created_by IS NOT NULL AND v_mkt.created_by = p_reviewer_id THEN
    RETURN QUERY SELECT false, 'You cannot review your own market', v_mkt.status,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- Same rule for a HOUSE market. created_by is NULL there (no fee share), so
  -- the check above passes and the person who submitted it could approve it
  -- alone — the exact loophole four eyes exists to prevent. submitted_by is
  -- recorded precisely so "no creator" never means "no accountability".
  IF v_mkt.submitted_by IS NOT NULL AND v_mkt.submitted_by = p_reviewer_id THEN
    RETURN QUERY SELECT false, 'You submitted this market — someone else must review it',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- The rubric, enforced. Approving a 6/12 should require honestly scoring it
  -- a 10, not clicking past a warning.
  IF p_decision = 'approve' THEN
    IF p_hard_gate IS NOT NULL AND btrim(p_hard_gate) <> '' THEN
      RETURN QUERY SELECT false, 'A hard gate was flagged — that is an automatic reject',
                          v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
      RETURN;
    END IF;
    IF p_score IS NULL OR p_score < 10 THEN
      RETURN QUERY SELECT false, 'Approval needs a score of 10 or more out of 12',
                          v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
      RETURN;
    END IF;
  ELSIF p_decision = 'revise' AND (p_notes IS NULL OR length(btrim(p_notes)) < 10) THEN
    -- A revision request with no notes is a rejection that wastes everyone's
    -- time twice.
    RETURN QUERY SELECT false, 'Say what needs changing', v_mkt.status,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- ── Reject / revise: no money moves, no book opens ──────────────────────
  IF p_decision IN ('revise','reject') THEN
    UPDATE public.open_markets
       SET status       = CASE WHEN p_decision = 'revise' THEN 'revise' ELSE 'rejected' END,
           review_score = p_score,
           review_notes = p_notes,
           reviewed_by  = p_reviewer_id,
           -- Bond returns on rejection; a revision keeps it held, since the
           -- submission is still live and one resubmission is free.
           bond_status  = CASE
             WHEN p_decision = 'reject' AND v_mkt.bond_status = 'held' THEN 'returned'
             ELSE v_mkt.bond_status END
     WHERE id = p_market_id;

    -- Refund the bond to the wallet it came from. Market lock is already held
    -- and the user lock is taken after it — the same order execute_open_trade
    -- uses, so these two can never deadlock against each other.
    IF p_decision = 'reject' AND v_mkt.bond_status = 'held'
       AND v_mkt.created_by IS NOT NULL
       AND (v_mkt.bond_tngn > 0 OR v_mkt.bond_bonus_tngn > 0) THEN
      PERFORM public.credit_user(v_mkt.created_by, v_mkt.bond_tngn, v_mkt.bond_bonus_tngn);
    END IF;

    INSERT INTO public.open_market_reviews
      (market_id, reviewer_id, decision, score, scores, hard_gate, notes)
    VALUES (p_market_id, p_reviewer_id, p_decision, p_score, p_scores, p_hard_gate, p_notes);

    RETURN QUERY SELECT true, 'recorded',
                        CASE WHEN p_decision = 'revise' THEN 'revise' ELSE 'rejected' END,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- ── Approve ────────────────────────────────────────────────────────────
  IF NOT COALESCE(v_cfg.trading_enabled, false) THEN
    RETURN QUERY SELECT false, 'Open Markets are paused — resume before approving',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  v_n := COALESCE(array_length(v_mkt.outcomes, 1), 0);
  IF v_n < 2 THEN
    RETURN QUERY SELECT false, 'Market has no valid outcomes', v_mkt.status,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- Category may have been removed from the allowlist between submission and
  -- review. The allowlist at APPROVAL time is the one that binds.
  IF NOT (lower(btrim(v_mkt.category)) = ANY (v_cfg.allowed_categories)) THEN
    RETURN QUERY SELECT false, 'Category ' || v_mkt.category || ' is not on the allowlist',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  v_b := CASE lower(COALESCE(p_tier,''))
           WHEN 'starter'  THEN 10000
           WHEN 'standard' THEN 25000
           WHEN 'featured' THEN 75000
           ELSE NULL END;
  IF v_b IS NULL THEN
    RETURN QUERY SELECT false, 'Choose a liquidity tier', v_mkt.status,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;
  IF v_b > COALESCE(v_cfg.max_market_b_tngn, 75000) THEN
    RETURN QUERY SELECT false, 'That tier is above the current per-market ceiling',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- b is immutable once open, so this is the only moment it can be set. The
  -- book must still be untouched for that to be safe.
  IF EXISTS (SELECT 1 FROM unnest(v_mkt.q) x WHERE x <> 0)
     OR EXISTS (SELECT 1 FROM public.open_trades WHERE market_id = p_market_id) THEN
    RETURN QUERY SELECT false, 'This book already has trades — it cannot be re-opened',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  v_closes  := COALESCE(p_trading_closes_at, v_mkt.trading_closes_at);
  v_horizon := COALESCE(p_horizon_at, v_mkt.horizon_at);

  -- An open market MUST have a trading cut-off, or the book is still live
  -- while the outcome becomes public and an admin walks to the resolve screen.
  IF v_closes IS NULL THEN
    RETURN QUERY SELECT false, 'Set the time trading stops', v_mkt.status,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;
  IF v_closes <= now() THEN
    RETURN QUERY SELECT false, 'Trading would close in the past', v_mkt.status,
                        NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;
  -- A horizon AFTER trading closes can never fire: the book is shut, so a
  -- holder offered "stay in or cash out" has no market to stay in.
  IF v_horizon IS NOT NULL AND v_horizon >= v_closes THEN
    RETURN QUERY SELECT false, 'The review date must fall before trading closes',
                        v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
    RETURN;
  END IF;

  -- Worst case the house can lose on this market is exactly b·ln(N), and the
  -- creator threshold is the same number: the house recovers its entire
  -- maximum exposure before a single naira is shared.
  v_worst := v_b * ln(v_n::numeric);
  v_thr   := v_worst;

  SELECT COALESCE(SUM(b * ln(COALESCE(array_length(outcomes,1),2)::numeric)), 0)
    INTO v_committed
    FROM public.open_markets
   WHERE status IN ('open','horizon_window','halted','pending_payout');

  IF v_committed + v_worst > COALESCE(v_cfg.max_total_exposure_tngn, 500000) THEN
    RETURN QUERY SELECT false,
      'Fleet exposure cap reached (' || round(v_committed) || ' committed of '
        || round(COALESCE(v_cfg.max_total_exposure_tngn, 500000)) || '). Resolve a market or raise the cap.',
      v_mkt.status, v_b, v_thr, v_worst;
    RETURN;
  END IF;

  UPDATE public.open_markets
     SET status            = 'open',
         b                 = v_b,
         threshold_tngn    = v_thr,
         trading_closes_at = v_closes,
         horizon_at        = v_horizon,
         dispute_window_hours = COALESCE(p_dispute_window_hours, dispute_window_hours),
         review_score      = p_score,
         review_notes      = p_notes,
         reviewed_by       = p_reviewer_id,
         bond_status       = CASE WHEN bond_status = 'none' THEN 'none' ELSE 'held' END,
         opened_at         = now()
   WHERE id = p_market_id;

  INSERT INTO public.open_market_reviews
    (market_id, reviewer_id, decision, score, scores, hard_gate, notes, tier, b_tngn)
  VALUES (p_market_id, p_reviewer_id, 'approve', p_score, p_scores, NULL, p_notes,
          lower(p_tier), v_b);

  RETURN QUERY SELECT true, 'approved', 'open'::text, v_b, v_thr, v_worst;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_open_trade(
  p_client_trade_id uuid,      -- idempotency anchor; caller generates it
  p_market_id       uuid,
  p_user_id         uuid,
  p_outcome_idx     integer,
  p_delta_shares    numeric,   -- + buy, − sell
  p_limit_tngn      numeric    -- buy: max total cost. sell: min proceeds.
)
RETURNS TABLE (
  outcome       text,          -- executed | already_executed
  cost_tngn     numeric,
  fee_tngn      numeric,
  total_tngn    numeric,       -- signed: + leaves wallet, − enters it
  shares_after  numeric,
  price_after   numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_fee_pct   constant numeric := 0.015;
  c_min_trade constant numeric := 100;     -- ₦100. Below this the fee rounds
                                           -- away, and LMSR is path-independent,
                                           -- so subdivision would avoid it entirely.
  c_creator_share constant numeric := 0.25;

  v_mkt      public.open_markets%ROWTYPE;
  v_prior    public.open_trades%ROWTYPE;
  v_pos      public.open_positions%ROWTYPE;
  v_held     numeric := 0;
  v_n        integer;
  v_idx      integer;
  v_next     numeric[];
  v_raw      numeric;
  v_cost     numeric;
  v_fee      numeric;
  v_total    numeric;
  v_cash     numeric;
  v_other    bigint;
  v_basis_sold  numeric := 0;
  v_accr_before numeric;
  v_accr_after  numeric;
BEGIN
  -- ── 1. Idempotency FIRST. A committed trade whose response was lost must
  -- replay, not re-execute. The row lock prevents interleaving; only this
  -- prevents repetition.
  SELECT * INTO v_prior FROM public.open_trades
   WHERE client_trade_id = p_client_trade_id;
  IF FOUND THEN
    -- The key alone is not enough. client_trade_id is a column on open_trades,
    -- so without this check a caller replaying someone else's key receives
    -- that trade's cost, fee, size and fill price — a confident "success" for
    -- a trade they never made, and a disclosure of another user's economics.
    IF v_prior.user_id      <> p_user_id
       OR v_prior.market_id   <> p_market_id
       OR v_prior.outcome_idx <> p_outcome_idx
       OR v_prior.delta_shares <> p_delta_shares THEN
      RAISE EXCEPTION 'client_trade_id % already used for a different trade',
        p_client_trade_id USING ERRCODE = 'P0001';
    END IF;
    -- Replay the RECORDED result. Re-reading the live position here would
    -- report a figure another trade has since moved, so a retrying client
    -- would see a number that never corresponded to its own trade.
    RETURN QUERY SELECT 'already_executed'::text, v_prior.cost_tngn, v_prior.fee_tngn,
                        v_prior.cost_tngn + v_prior.fee_tngn,
                        v_prior.shares_after, v_prior.price_after;
    RETURN;
  END IF;

  -- ── 2. Lock the market. This serialises every trader on this book.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'market not found' USING ERRCODE = 'P0002';
  END IF;

  -- Engine-wide kill switch. A per-market halt is not enough when the fault is
  -- in the pricing function itself.
  -- COALESCE is load-bearing: if the singleton row is missing, the subquery is
  -- NULL, NOT NULL is NULL, and plpgsql takes NEITHER branch — the kill switch
  -- silently fails OPEN, which is the one behaviour it must never have.
  IF NOT COALESCE((SELECT trading_enabled FROM public.open_markets_config WHERE id = 1), false) THEN
    RAISE EXCEPTION 'open markets trading is disabled' USING ERRCODE = 'P0001';
  END IF;

  IF v_mkt.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open (status=%)', v_mkt.status USING ERRCODE = 'P0001';
  END IF;
  IF v_mkt.trading_closes_at IS NOT NULL AND now() >= v_mkt.trading_closes_at THEN
    RAISE EXCEPTION 'trading closed' USING ERRCODE = 'P0001';
  END IF;
  -- Freeze by the CLOCK, not by when the horizon cron happens to fire.
  -- horizon_at is on a publicly readable table, so any lag between the
  -- published time and the job flipping the status is a window in which
  -- everyone knows an unwind is coming and can still exit at full price.
  IF v_mkt.horizon_at IS NOT NULL AND now() >= v_mkt.horizon_at THEN
    RAISE EXCEPTION 'horizon reached; trading frozen pending review' USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. Creators may never trade their own market.
  -- They write the question, so they hold the best prior on the platform, AND
  -- they have the audience the growth model depends on. Buying one side while
  -- promoting the other is a ~54% return funded entirely by their own
  -- followers — and it shows up on a house-P&L dashboard as a PROFITABLE
  -- market, so it is invisible unless it is simply prevented. Their
  -- compensation is the fee share; that is the point of it.
  IF v_mkt.created_by IS NOT NULL AND v_mkt.created_by = p_user_id THEN
    RAISE EXCEPTION 'creators cannot trade their own market' USING ERRCODE = 'P0001';
  END IF;

  -- And the admin who submitted it, house market or not. On a house market
  -- created_by is NULL, so without this an admin could submit a market, get
  -- it approved, trade it, and then resolve it — the whole loop, with the
  -- outcome in their gift. That is insider trading, and it leaves no trace
  -- unless it is simply refused here.
  IF v_mkt.submitted_by IS NOT NULL AND v_mkt.submitted_by = p_user_id THEN
    RAISE EXCEPTION 'whoever submitted this market cannot trade it' USING ERRCODE = 'P0001';
  END IF;

  v_n := array_length(v_mkt.outcomes, 1);
  -- array_length of an empty array is NULL, and every guard below compares
  -- against it. A NULL there is not "unknown", it is "no check ran": the
  -- range check, complete-set check, minimum-trade check, both slippage
  -- guards and the BALANCE check all evaluate to NULL and fall through.
  IF v_n IS NULL OR v_n < 2 THEN
    RAISE EXCEPTION 'market has no valid outcomes' USING ERRCODE = 'P0001';
  END IF;
  IF p_outcome_idx < 0 OR p_outcome_idx >= v_n THEN
    RAISE EXCEPTION 'outcome index out of range' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares IS NULL OR p_delta_shares = 0 THEN
    RAISE EXCEPTION 'delta_shares must be non-zero' USING ERRCODE = 'P0001';
  END IF;
  v_idx := p_outcome_idx + 1;   -- postgres arrays are 1-based

  -- ── 4. Existing position.
  SELECT * INTO v_pos FROM public.open_positions
   WHERE market_id = p_market_id AND user_id = p_user_id AND outcome_idx = p_outcome_idx
   FOR UPDATE;
  IF FOUND THEN v_held := v_pos.shares_cash + v_pos.shares_bonus; END IF;

  -- ── 5. No naked shorts. Selling shares you don't hold is borrowing from the
  -- house: proceeds asymptote to b·ln(N) while the liability grows linearly,
  -- so the house's loss is unbounded rather than capped.
  -- v1 is cash-only. Refuse rather than corrupt if that ever stops being true:
  -- the write below decrements shares_cash alone, so validating a sell against
  -- cash+bonus would drive shares_cash negative and make the position
  -- permanently unsellable the day a single bonus share exists.
  IF p_delta_shares < 0 AND v_pos.shares_bonus > 0 THEN
    RAISE EXCEPTION 'bonus lots are not sellable in v1' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares < 0 AND COALESCE(v_pos.shares_cash, 0) + p_delta_shares < 0 THEN
    RAISE EXCEPTION 'cannot sell more shares than held' USING ERRCODE = 'P0001';
  END IF;

  -- ── 6. No complete sets. Holding every outcome is a risk-free instrument
  -- (cost == payout exactly). Harmless with one currency; with two it is a
  -- laundering path, and it is a pure drain on fees regardless.
  IF p_delta_shares > 0 AND v_n > 1 THEN
    SELECT count(*) INTO v_other FROM public.open_positions
     WHERE market_id = p_market_id AND user_id = p_user_id
       AND outcome_idx <> p_outcome_idx AND (shares_cash + shares_bonus) > 0;
    IF v_other >= v_n - 1 THEN
      RAISE EXCEPTION 'this trade would complete a set' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 6b. Per-account position cap. One account cornering the book realises
  -- the house's whole subsidy without any second opinion ever being expressed,
  -- which is both an exposure event and a worthless market.
  IF p_delta_shares > 0
     AND (v_held + p_delta_shares) > v_mkt.max_position_mult * v_mkt.b THEN
    RAISE EXCEPTION 'position cap: max % shares of one outcome',
      v_mkt.max_position_mult * v_mkt.b USING ERRCODE = 'P0001';
  END IF;

  -- ── 7. Price from the LOCKED book.
  v_next := v_mkt.q;
  v_next[v_idx] := v_next[v_idx] + p_delta_shares;
  v_raw  := public.lmsr_cost(v_next, v_mkt.b) - public.lmsr_cost(v_mkt.q, v_mkt.b);

  -- ceil() is house-favourable in BOTH directions: on a buy it raises what the
  -- user pays; on a sell the cost is negative, so ceil moves it toward zero and
  -- shrinks what the user receives. Flooring a sell would hand out a fraction
  -- of a kobo on every single exit.
  v_cost := ceil(v_raw * 100) / 100;

  -- The minimum blocks ENTRIES, not exits: a residual position worth ₦80 must
  -- still be closable or the user's money is trapped by a guard meant to
  -- protect fee revenue.
  IF abs(v_cost) < c_min_trade
     AND NOT (p_delta_shares < 0 AND v_pos.shares_cash + p_delta_shares = 0) THEN
    RAISE EXCEPTION 'trade below minimum of %', c_min_trade USING ERRCODE = 'P0001';
  END IF;

  v_fee   := GREATEST(ceil(abs(v_cost) * c_fee_pct * 100) / 100, 0.01);
  v_total := v_cost + v_fee;

  -- ── 8. Slippage guard, compared against what actually leaves the wallet.
  -- Comparing against the pre-fee cost would make every user's guard 1.5%
  -- looser than they believe. Mandatory in BOTH directions — a sell needs a
  -- floor on proceeds exactly as a buy needs a ceiling on cost.
  IF p_limit_tngn IS NULL THEN
    RAISE EXCEPTION 'p_limit_tngn is required' USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares > 0 AND v_total > p_limit_tngn THEN
    RAISE EXCEPTION 'slippage: cost % exceeds limit %', v_total, p_limit_tngn
      USING ERRCODE = 'P0001';
  END IF;
  IF p_delta_shares < 0 AND (-v_total) < p_limit_tngn THEN
    RAISE EXCEPTION 'slippage: proceeds % below limit %', -v_total, p_limit_tngn
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 9. Wallet, under the user row lock. Debiting via credit_user would be
  -- wrong: it CLAMPS at zero, so an over-debit succeeds silently and the
  -- shortfall disappears instead of raising.
  SELECT tngn_balance INTO v_cash FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_delta_shares > 0 THEN
    IF COALESCE(v_cash, 0) < v_total THEN
      RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.users SET tngn_balance = tngn_balance - v_total WHERE id = p_user_id;
  ELSE
    UPDATE public.users SET tngn_balance = tngn_balance + (-v_total) WHERE id = p_user_id;
  END IF;

  -- ── 10. Position lots. v1 is cash-only, so everything lands in the cash lot.
  IF v_pos.id IS NULL THEN
    INSERT INTO public.open_positions (market_id, user_id, outcome_idx, shares_cash, cost_cash)
    VALUES (p_market_id, p_user_id, p_outcome_idx, p_delta_shares, v_total)
    RETURNING * INTO v_pos;
  ELSIF p_delta_shares > 0 THEN
    UPDATE public.open_positions
       SET shares_cash = shares_cash + p_delta_shares,
           cost_cash   = cost_cash   + v_total
     WHERE id = v_pos.id
     RETURNING * INTO v_pos;
  ELSE
    -- Selling retires basis PROPORTIONALLY. Subtracting the proceeds instead
    -- would leave the remaining shares carrying the wrong basis, and would push
    -- cost_cash negative on any profitable exit — making every P&L figure
    -- derived from it wrong.
    -- Denominator is the CASH lot, matching the lot being sold. Using
    -- cash+bonus here would retire the wrong fraction of basis.
    v_basis_sold := CASE WHEN v_pos.shares_cash > 0
                         THEN round(v_pos.cost_cash * (-p_delta_shares) / v_pos.shares_cash, 2)
                         ELSE 0 END;
    UPDATE public.open_positions
       SET shares_cash = shares_cash + p_delta_shares,
           cost_cash   = cost_cash - v_basis_sold
     WHERE id = v_pos.id
     RETURNING * INTO v_pos;
  END IF;

  -- ── 11. Book + fee accounting. Creator share ACCRUES on the market row we
  -- already hold — never paid inline. Crediting the creator's wallet here
  -- would couple every trader's fill to a second user row lock (deadlock risk)
  -- and would pay out money that a later void or ban cannot claw back.
  v_accr_before := GREATEST(v_mkt.fees_collected - v_mkt.threshold_tngn, 0);
  v_accr_after  := GREATEST(v_mkt.fees_collected + v_fee - v_mkt.threshold_tngn, 0);

  UPDATE public.open_markets
     SET q                   = v_next,
         fees_collected      = fees_collected + v_fee,
         -- v1 is cash-only, so every fee is 'real'. This stays a SEPARATE
         -- column because the day bonus lots land, only the cash-funded
         -- portion may count toward the creator threshold — otherwise free
         -- promotional credit would unlock creator payouts.
         fees_collected_real = fees_collected_real + v_fee,
         creator_accrued     = creator_accrued
                               + c_creator_share * (v_accr_after - v_accr_before)
   WHERE id = p_market_id;

  -- ── 11b. The FEE is house revenue and must reach the reserve. The v_cost
  -- portion is deliberately NOT credited: it is a liability deposit held
  -- against future payouts, and booking it as revenue would overstate the
  -- reserve by the entire size of the book.
  --
  -- This matters beyond reporting: reserve_health.deployable_tngn is derived
  -- from house_reserve.total_tngn, and place_bet_locked / place_multiplier_slip
  -- size their stake caps off it. An engine that moves real money without
  -- touching the reserve makes the OTHER engines mis-price.
  -- NOTE: the reserve is deliberately NOT touched here. apply_house_pnl_open
  -- locks house_reserve id=1, a platform-wide singleton, and this function
  -- already holds the USER row — while settle_multiplier_market takes them in
  -- the opposite order (apply_house_pnl then credit_user). That is an ABBA
  -- deadlock between the two engines, and it would abort a settlement sweep
  -- mid-payout. It would also serialise every trade on every open market
  -- behind one row, making the whole platform's money path single-threaded.
  --
  -- Fees accrue on the market row this transaction already holds, and a cron
  -- sweeps them to the reserve — exactly the argument already made above for
  -- not paying the creator inline.

  INSERT INTO public.treasury_log (type, amount_tngn, user_id, open_market_id, metadata)
  VALUES ('open_trade_fee', v_fee, p_user_id, p_market_id,
          jsonb_build_object('client_trade_id', p_client_trade_id,
                             'outcome_idx', p_outcome_idx,
                             'delta_shares', p_delta_shares,
                             'cost_tngn', v_cost));

  -- ── 12. Immutable log. q_after makes the whole book replayable from here.
  INSERT INTO public.open_trades (
    client_trade_id, market_id, user_id, outcome_idx, delta_shares,
    cost_tngn, fee_tngn, paid_cash, paid_bonus, price_after, q_after, shares_after)
  VALUES (
    p_client_trade_id, p_market_id, p_user_id, p_outcome_idx, p_delta_shares,
    v_cost, v_fee, v_total, 0,
    (public.lmsr_prices(v_next, v_mkt.b))[v_idx], v_next,
    v_pos.shares_cash + v_pos.shares_bonus);

  RETURN QUERY SELECT 'executed'::text, v_cost, v_fee, v_total,
                      v_pos.shares_cash + v_pos.shares_bonus,
                      (public.lmsr_prices(v_next, v_mkt.b))[v_idx];
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_open_market(
  p_market_id    uuid,
  p_outcome_idx  integer,
  p_resolved_by  uuid,
  p_confirmed_by uuid,
  p_evidence_url text,
  p_dry_run      boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, positions integer, winners integer,
               gross_tngn numeric, house_pnl numeric, locked_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt      public.open_markets%ROWTYPE;
  v_epoch    smallint;
  v_pos      integer;
  v_win      integer;
  v_gross    numeric;
  v_pool     numeric;
  v_until    timestamptz;
  v_bad      integer;
BEGIN
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  -- Trading must be OVER. Resolving an open book means the market is live
  -- while an admin is looking at the answer, with the house as counterparty to
  -- every one of those informed trades.
  IF v_mkt.status <> 'closed' THEN
    RETURN QUERY SELECT false, 'market must be closed first (status=' || v_mkt.status || ')',
                        0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_mkt.halted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'halted', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_outcome_idx < 0 OR p_outcome_idx >= COALESCE(array_length(v_mkt.outcomes,1),0) THEN
    RETURN QUERY SELECT false, 'outcome out of range', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;
  -- Four eyes, and never the creator.
  IF p_resolved_by IS NULL OR p_confirmed_by IS NULL OR p_resolved_by = p_confirmed_by THEN
    RETURN QUERY SELECT false, 'needs two distinct approvers', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_mkt.created_by IS NOT NULL
     AND (p_resolved_by = v_mkt.created_by OR p_confirmed_by = v_mkt.created_by) THEN
    RETURN QUERY SELECT false, 'creator cannot resolve their own market',
                        0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  -- Same for whoever submitted it. A house market has created_by NULL, so the
  -- check above does not fire, and the submitter could hand-pick the winning
  -- outcome on a book they were allowed to trade.
  IF v_mkt.submitted_by IS NOT NULL
     AND (p_resolved_by = v_mkt.submitted_by OR p_confirmed_by = v_mkt.submitted_by) THEN
    RETURN QUERY SELECT false, 'whoever submitted this market cannot resolve it',
                        0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  -- Refuse to settle a book that does not balance. Better to stop and be
  -- repaired than to pay out of a book we cannot explain.
  SELECT COUNT(*) INTO v_bad FROM public.verify_open_market_book(p_market_id) v WHERE NOT v.ok;
  IF v_bad > 0 THEN
    RETURN QUERY SELECT false, 'book fails ' || v_bad || ' invariant check(s) — refusing to settle',
                        0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  v_epoch := COALESCE((SELECT MAX(epoch) FROM public.open_settlements
                        WHERE market_id = p_market_id AND kind = 'resolve'), -1) + 1;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE outcome_idx = p_outcome_idx),
         COALESCE(SUM(shares_cash + shares_bonus) FILTER (WHERE outcome_idx = p_outcome_idx), 0)
    INTO v_pos, v_win, v_gross
    FROM public.open_positions
   WHERE market_id = p_market_id AND status = 'open'
     AND (shares_cash + shares_bonus) > 0;

  v_pool  := public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b);
  v_until := now() + make_interval(hours => v_mkt.dispute_window_hours);

  IF p_dry_run THEN
    RETURN QUERY SELECT false, 'dry_run', v_pos, v_win, v_gross, v_pool - v_gross, v_until;
    RETURN;
  END IF;

  -- Set-based. Losers settle to ZERO explicitly rather than being left open —
  -- otherwise any later sweep that pays "all open positions" pays them too.
  INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn, bonus)
  SELECT p.id, p.market_id, 'resolve', v_epoch,
         CASE WHEN p.outcome_idx = p_outcome_idx THEN 'par' ELSE 'zero' END,
         CASE WHEN p.outcome_idx = p_outcome_idx THEN p.shares_cash  ELSE 0 END,
         CASE WHEN p.outcome_idx = p_outcome_idx THEN p.shares_bonus ELSE 0 END
    FROM public.open_positions p
   WHERE p.market_id = p_market_id AND p.status = 'open'
     AND (p.shares_cash + p.shares_bonus) > 0;

  UPDATE public.open_positions SET status = 'settled', settled_at = now()
   WHERE market_id = p_market_id AND status = 'open';

  UPDATE public.open_markets
     SET status = 'pending_payout', pending_kind = 'resolve', payout_phase = 'computed',
         resolved_outcome = p_outcome_idx, resolved_by = p_resolved_by,
         resolution_confirmed_by = p_confirmed_by, resolution_evidence_url = p_evidence_url,
         resolved_at = now(), settlement_locked_until = v_until,
         max_hold_until = now() + interval '14 days'
   WHERE id = p_market_id;

  RETURN QUERY SELECT true, 'computed', v_pos, v_win, v_gross, v_pool - v_gross, v_until;
END;
$$;

-- Permissions are dropped with the function, so restore them for the new
-- submit_open_market signature. The other three were replaced in place and
-- keep their existing grants.
REVOKE ALL ON FUNCTION
  public.submit_open_market(uuid,text,text,text,text[],text,text,timestamptz,timestamptz,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.submit_open_market(uuid,text,text,text,text[],text,text,timestamptz,timestamptz,text,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
