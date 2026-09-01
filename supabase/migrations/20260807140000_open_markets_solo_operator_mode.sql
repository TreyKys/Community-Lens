-- Solo operator mode.
--
-- Four-eyes assumes a second person exists. On a platform with exactly one
-- admin, that assumption is simply false — there is nobody to hand a
-- submission to, and a control that can never be satisfied is not a control,
-- it is a permanently locked door. The honest fix is not to quietly relax
-- the check and hope nobody notices; it is to make the single-operator case
-- an explicit, visible, OPT-IN mode that still leaves a mark on every record
-- it touches.
--
-- WHAT THIS DOES NOT TOUCH, under any setting:
--
--   * execute_open_trade's "whoever created or submitted this market cannot
--     trade it" guard. That is the check that protects OTHER PEOPLE'S money
--     from an insider trading against them — it has nothing to do with how
--     many admins exist, and solo mode does not go near it.
--   * Any market with a creator (created_by IS NOT NULL). Self-approving or
--     self-resolving a market you also stand to earn 25% of the fees on is
--     the exact insider-trading hole 20260807040000 closed. Solo mode is
--     scoped to HOUSE markets only — nobody is paid a creator share on one,
--     so there is no profit motive for the one guard that remains: honesty
--     about who actually looked at it.
--
-- What it DOES allow, only when explicitly switched on, only for a house
-- market: the same person may submit AND approve it, and the same person may
-- be both resolver and confirmer. Both are stamped (self_reviewed,
-- self_resolved) so a market approved or resolved this way is never
-- indistinguishable from one that had genuine second-person oversight —
-- visible on the exposure dashboard and in the review history, not hidden.
--
-- Both functions below are extracted from 20260807040000 and patched with
-- Python string replacement, not retyped — a diff against that source shows
-- exactly the lines noted in this migration's commit and nothing else.

ALTER TABLE public.open_markets_config
  ADD COLUMN IF NOT EXISTS solo_operator_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS solo_operator_set_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS solo_operator_set_at timestamptz;

ALTER TABLE public.open_markets
  ADD COLUMN IF NOT EXISTS self_reviewed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS self_resolved boolean NOT NULL DEFAULT false;

-- ── review_open_market ──────────────────────────────────────────────────────
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
  -- Set true only inside the solo-mode bypass below. Every other approval
  -- path — including every approval before this migration existed — writes
  -- false, so a market's own record shows whether a second person actually
  -- looked at it.
  v_self_reviewed boolean := false;
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
  --
  -- UNLESS solo_operator_mode is on: on a platform with exactly one admin
  -- there is nobody else to hand this to, and this is the one check that
  -- bends for that reality — never the created_by check above, since a
  -- creator earns a fee share and self-approving that is the exact
  -- insider-trading hole this whole mechanism exists to close.
  IF v_mkt.submitted_by IS NOT NULL AND v_mkt.submitted_by = p_reviewer_id THEN
    IF v_cfg.solo_operator_mode AND v_mkt.created_by IS NULL THEN
      v_self_reviewed := true;
    ELSE
      RETURN QUERY SELECT false, 'You submitted this market — someone else must review it',
                          v_mkt.status, NULL::numeric, NULL::numeric, NULL::numeric;
      RETURN;
    END IF;
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
         opened_at         = now(),
         self_reviewed     = v_self_reviewed
   WHERE id = p_market_id;

  INSERT INTO public.open_market_reviews
    (market_id, reviewer_id, decision, score, scores, hard_gate, notes, tier, b_tngn)
  VALUES (p_market_id, p_reviewer_id, 'approve', p_score, p_scores, NULL, p_notes,
          lower(p_tier), v_b);

  RETURN QUERY SELECT true, 'approved', 'open'::text, v_b, v_thr, v_worst;
END;
$$;

-- ── settle_open_market ──────────────────────────────────────────────────────
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
  v_cfg      public.open_markets_config%ROWTYPE;
  v_epoch    smallint;
  v_pos      integer;
  v_win      integer;
  v_gross    numeric;
  v_pool     numeric;
  v_until    timestamptz;
  v_bad      integer;
  v_self_resolved boolean := false;
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
  SELECT * INTO v_cfg FROM public.open_markets_config WHERE id = 1;

  -- Four eyes, and never the creator — UNLESS solo mode is on and this is a
  -- house market, in which case one person may stand in as both signatures.
  -- A real id is still required either way; only the distinctness
  -- requirement, and only for a market where nobody earns a creator share,
  -- is what bends.
  IF v_cfg.solo_operator_mode AND v_mkt.created_by IS NULL THEN
    IF p_resolved_by IS NULL OR p_confirmed_by IS NULL THEN
      RETURN QUERY SELECT false, 'needs an approver', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
      RETURN;
    END IF;
    v_self_resolved := (p_resolved_by = p_confirmed_by);
  ELSE
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
         -- NULL, not p_confirmed_by, on a genuine self-resolve. The table's
         -- own open_markets_four_eyes CHECK constraint requires resolved_by
         -- and resolution_confirmed_by to be genuinely distinct whenever
         -- BOTH are non-null — a schema-level backstop this migration
         -- deliberately does not touch, since a CHECK constraint cannot see
         -- open_markets_config to know solo mode is even on. Storing NULL
         -- here satisfies that constraint honestly: it says there was no
         -- second confirmer, which is the truth, rather than storing the
         -- same id twice and asking the constraint to make an exception.
         resolution_confirmed_by = CASE WHEN v_self_resolved THEN NULL ELSE p_confirmed_by END,
         resolution_evidence_url = p_evidence_url,
         resolved_at = now(), settlement_locked_until = v_until,
         max_hold_until = now() + interval '14 days',
         self_resolved = v_self_resolved
   WHERE id = p_market_id;

  RETURN QUERY SELECT true, 'computed', v_pos, v_win, v_gross, v_pool - v_gross, v_until;
END;
$$;

-- ── Toggle, with its own accountability trail ───────────────────────────────
-- Not a bare UPDATE from the API route: turning this on is the one action in
-- the whole engine that widens what a single person can do alone, so who did
-- it and when is worth its own record rather than living only in
-- updated_at, which every other config change also touches.
CREATE OR REPLACE FUNCTION public.set_open_markets_solo_mode(
  p_admin_id uuid,
  p_enabled  boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin identity required' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.open_markets_config
     SET solo_operator_mode   = p_enabled,
         solo_operator_set_by = p_admin_id,
         solo_operator_set_at = now(),
         updated_at           = now()
   WHERE id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.set_open_markets_solo_mode(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_open_markets_solo_mode(uuid, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
