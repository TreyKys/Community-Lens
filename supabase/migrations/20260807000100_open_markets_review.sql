-- Open Markets: the approval gate.
--
-- The review queue is the primary anti-abuse control for this engine. It is
-- cheaper and far more reliable than detecting manipulation after money has
-- moved — once a market is open, every defence left is damage limitation.
--
-- Everything the rubric can be expressed as a machine check, IS one here.
-- A rubric that lives only in a document gets skipped at 2am on market number
-- forty. What's left for the human is the part a machine genuinely cannot do:
-- reading the question and judging intent.

-- ── Category allowlist, enforced rather than documented ────────────────────
-- Deliberately narrow at launch. Widening later is one UPDATE; unwinding a
-- category that turned out to be a manipulation vector is not.
ALTER TABLE public.open_markets_config
  ADD COLUMN IF NOT EXISTS allowed_categories text[] NOT NULL DEFAULT ARRAY[
    'sport', 'politics', 'economy', 'entertainment',
    'technology', 'weather', 'company'
  ];

-- Tier ceiling for the whole fleet, separate from max_total_exposure_tngn:
-- that one caps the SUM, this caps any single market. Without it one Featured
-- approval can eat the entire remaining budget in a single click.
ALTER TABLE public.open_markets_config
  ADD COLUMN IF NOT EXISTS max_market_b_tngn numeric NOT NULL DEFAULT 75000;

-- Audit trail. review_score/review_notes on open_markets hold the LATEST
-- decision only, and a market can legitimately go pending_review → revise →
-- pending_review → open. Overwriting loses exactly the history you need when
-- asking why a bad market got through.
CREATE TABLE IF NOT EXISTS public.open_market_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    uuid NOT NULL REFERENCES public.open_markets(id) ON DELETE CASCADE,
  reviewer_id  uuid REFERENCES public.users(id),
  decision     text NOT NULL CHECK (decision IN ('approve','revise','reject')),
  score        smallint CHECK (score IS NULL OR (score >= 0 AND score <= 12)),
  -- Per-dimension scores, so a miscalibrated reviewer is visible in aggregate
  -- rather than hidden inside one total.
  scores       jsonb,
  hard_gate    text,
  notes        text,
  tier         text,
  b_tngn       numeric,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS open_market_reviews_market_idx
  ON public.open_market_reviews (market_id, created_at DESC);

ALTER TABLE public.open_market_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS open_market_reviews_service ON public.open_market_reviews;
CREATE POLICY open_market_reviews_service ON public.open_market_reviews
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');


-- ── Submit a market for review ─────────────────────────────────────────────
-- Lands in pending_review, invisible to everyone but admins. b is a
-- placeholder here and is set for real at approval from the tier: letting a
-- submitter choose their own liquidity would let them choose the house's
-- maximum loss on their market.
CREATE OR REPLACE FUNCTION public.submit_open_market(
  p_created_by        uuid,
  p_question          text,
  p_description       text,
  p_category          text,
  p_outcomes          text[],
  p_resolution_source text,
  p_resolution_detail text DEFAULT NULL,
  p_horizon_at        timestamptz DEFAULT NULL,
  p_trading_closes_at timestamptz DEFAULT NULL
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
    horizon_at, trading_closes_at, created_by
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
    p_horizon_at, p_trading_closes_at, p_created_by
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT true, 'submitted', v_id;
END;
$$;


-- ── Review a submission ────────────────────────────────────────────────────
-- One RPC for all three decisions, because approving is the only one that can
-- lose money and it must not be reachable by any path that skips these checks.
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


-- ── Admin queue view ───────────────────────────────────────────────────────
-- Carries the creator's track record inline: "has this person had a market
-- resolve cleanly before" is the single most useful thing a reviewer can know,
-- and looking it up per submission by hand means it never gets looked up.
--
-- DROP then CREATE, not CREATE OR REPLACE. A later migration
-- (20260807030000) redefines this same view with an extra column inserted
-- in the middle of the list — CREATE OR REPLACE VIEW can only ever APPEND
-- columns at the end, so on a database where that later migration already
-- ran, replaying this one as OR REPLACE fails with "cannot drop columns
-- from view". Nothing depends on this view except the admin queue route, so
-- dropping it first is safe regardless of which shape is currently live.
DROP VIEW IF EXISTS public.open_markets_review_queue;
CREATE VIEW public.open_markets_review_queue AS
SELECT
  m.id, m.question, m.description, m.category, m.outcomes,
  m.resolution_source, m.resolution_detail, m.revision_policy,
  m.unresolvable_policy, m.horizon_at, m.trading_closes_at,
  m.status, m.review_score, m.review_notes, m.created_by, m.created_at,
  u.username            AS creator_handle,
  u.email               AS creator_email,
  (SELECT count(*) FROM public.open_markets x
    WHERE x.created_by = m.created_by AND x.status = 'resolved')  AS creator_resolved,
  (SELECT count(*) FROM public.open_markets x
    WHERE x.created_by = m.created_by AND x.status = 'rejected')  AS creator_rejected,
  (SELECT count(*) FROM public.open_markets x
    WHERE x.created_by = m.created_by AND x.status = 'voided')    AS creator_voided,
  (SELECT count(*) FROM public.open_market_disputes d
     JOIN public.open_markets x ON x.id = d.market_id
    WHERE x.created_by = m.created_by)                            AS creator_disputes
FROM public.open_markets m
LEFT JOIN public.users u ON u.id = m.created_by
WHERE m.status IN ('pending_review','revise');

REVOKE ALL ON public.open_markets_review_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.open_markets_review_queue TO service_role;

REVOKE ALL ON FUNCTION public.submit_open_market(uuid,text,text,text,text[],text,text,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_open_market(uuid,text,text,text,text[],text,text,timestamptz,timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.review_open_market(uuid,uuid,text,smallint,jsonb,text,text,text,timestamptz,timestamptz,smallint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_open_market(uuid,uuid,text,smallint,jsonb,text,text,text,timestamptz,timestamptz,smallint)
  TO service_role;

NOTIFY pgrst, 'reload schema';
