-- Open Markets: event_tag — the routing hook for hub pages like /bbn.
--
-- Locked Odds and the LMSR trading engine are two STAKING MODES, not two
-- separate products. A market on either engine should be able to land on a
-- themed hub page (Football today, BBN as of this migration, whatever comes
-- next) — the engine underneath is an implementation detail, not something
-- that should decide where a market is discoverable.
--
-- The locked-odds side already has this: a market gets `sport` + `league_code`
-- and /football or /league/[id] filters on them. Open Markets had no
-- equivalent, so an LMSR market about who wins BBN had nowhere to surface
-- except the generic /open browse list, mixed in with everything else.
--
-- Deliberately a free-text column, not an enum and not literally "bbn" baked
-- into the schema: the next cultural hub (an election, an award show,
-- whatever) reuses this column with a new value and a new hub page, no
-- migration required. Nullable and unindexed-by-default-usage — most Open
-- Markets will never set it, and that's correct: this is for the handful of
-- markets big enough to deserve their own page, not a general tagging system.

ALTER TABLE public.open_markets
  ADD COLUMN IF NOT EXISTS event_tag text;

CREATE INDEX IF NOT EXISTS open_markets_event_tag_idx
  ON public.open_markets (event_tag) WHERE event_tag IS NOT NULL;

-- ── submit_open_market: one new trailing DEFAULT NULL param ────────────────
-- Application-level callers are backward-compatible with the new signature —
-- a caller that omits eventTag still works, it defaults to NULL.
--
-- The DATABASE level is not automatically compatible, and this is the trap:
-- function identity in Postgres includes the parameter list, so CREATE OR
-- REPLACE with an appended parameter creates a SECOND overload rather than
-- replacing the first. Calling by named arguments (which is what
-- supabase-js .rpc() always does) would then be AMBIGUOUS between the old
-- 9-arg and new 10-arg versions whenever a caller omits p_event_tag — every
-- existing call site — and Postgres raises "function is not unique" instead
-- of picking one. The old signature must be dropped, not left to coexist.
DROP FUNCTION IF EXISTS public.submit_open_market(
  uuid, text, text, text, text[], text, text, timestamptz, timestamptz
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
  p_event_tag         text DEFAULT NULL
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
    horizon_at, trading_closes_at, created_by, event_tag
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
    NULLIF(lower(btrim(COALESCE(p_event_tag,''))), '')
  ) RETURNING id INTO v_id;

  RETURN QUERY SELECT true, 'submitted', v_id;
END;
$$;

-- ── Review queue: surface the tag so a reviewer sees at a glance which hub
--    a submission is headed for ──────────────────────────────────────────
--
-- DROP then CREATE, not CREATE OR REPLACE. Replacing a view can only APPEND
-- columns to the end of the select list — adding one in the middle (event_tag
-- sits before creator_handle here, next to the other market columns it
-- belongs with) is read by Postgres as renaming every column after it, and it
-- refuses with "cannot change name of view column". Nothing depends on this
-- view except the admin queue route, so dropping it is safe.
DROP VIEW IF EXISTS public.open_markets_review_queue;

CREATE VIEW public.open_markets_review_queue AS
SELECT
  m.id, m.question, m.description, m.category, m.outcomes,
  m.resolution_source, m.resolution_detail, m.revision_policy,
  m.unresolvable_policy, m.horizon_at, m.trading_closes_at,
  m.status, m.review_score, m.review_notes, m.created_by, m.created_at,
  m.event_tag,
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

REVOKE ALL ON FUNCTION
  public.submit_open_market(uuid,text,text,text,text[],text,text,timestamptz,timestamptz,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.submit_open_market(uuid,text,text,text,text[],text,text,timestamptz,timestamptz,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
