-- Raise the Open Markets outcome ceiling from 8 to 30.
--
-- 8 was fine for 1X2/BTTS-shaped questions but is genuinely too low for
-- exactly the kind of market this platform's own hub pages are built
-- around: a BBN eviction ("who leaves this week?") or an NPFL title race
-- can easily have 12-20+ live candidates, and 8 forces an admin to either
-- reject a perfectly good market or artificially merge distinct people/teams
-- into one bucket, which is worse — it makes the resolution ambiguous
-- exactly where 20260807000100's own outcome-duplication guard was trying
-- to prevent that.
--
-- Nothing else needed to change to support this: outcomes/q/q_initial are
-- plain arrays with no upper-bound CHECK at the table level (only a >= 2
-- minimum — see open_markets_outcomes_min in 20260806000000), and every
-- function that reads array_length(outcomes, 1) — execute_open_trade,
-- settle_open_market, review_open_market's approval math — is already
-- written generically over N, not hardcoded to 8. This migration only
-- widens the one hardcoded ceiling: the submission-time guard.
--
-- Byte-for-byte the same function as 20260807040000, less this one number
-- and its message.
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
  IF v_n < 2 OR v_n > 30 THEN
    RETURN QUERY SELECT false, 'A market needs between 2 and 30 outcomes', NULL::uuid; RETURN;
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

-- Signature is unchanged from 20260807040000 (same params, same order), so
-- no DROP FUNCTION / re-GRANT dance is needed here — CREATE OR REPLACE
-- keeps the existing grants in place.

NOTIFY pgrst, 'reload schema';
