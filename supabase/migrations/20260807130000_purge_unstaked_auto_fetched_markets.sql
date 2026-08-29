-- Clear the auto-fetched backlog — but only what nobody has touched.
--
-- The seed bot has been creating markets since football-data.org was wired
-- up, across twelve leagues (now three — see the FOOTBALL_LEAGUES change).
-- Most of what it made never drew a single stake: a BTTS sub-market on a
-- Dutch second-tier fixture is a real row in the database and, in practice,
-- dead weight on the board.
--
-- WHAT THIS DOES NOT DO: touch anything with real money or history on it.
-- "Delete everything auto-fetched" and "delete everything nobody staked" are
-- different operations, and the difference matters — a market someone
-- currently holds a live position on will still resolve when its match
-- finishes and pay out normally through the existing auto-resolve cron,
-- whatever league it belongs to. Force-voiding it here would hand back their
-- stake, yes, but it would also unilaterally cancel a bet they placed in
-- good faith, for a reason that has nothing to do with whether the bet is
-- good. That is not this migration's call to make.
--
-- So the rule is narrow and mechanical: an auto-fetched market (fixture_id
-- IS NOT NULL — the seed job is the only writer that ever sets it; the admin
-- panel and the AI bulk generator both set it to NULL) is deleted only if
-- NOTHING anywhere references it. Five tables can:
--
--   user_bets, multiplier_legs, vip_referral_earnings, bet_insurance_events,
--   merkle_commits
--
-- all NOT NULL REFERENCES markets(id) with no ON DELETE clause, i.e. RESTRICT
-- — Postgres itself refuses the delete if any of them has a row. That FK is
-- the real safety net; the NOT EXISTS checks below exist to make the common
-- case fast and to report WHY a row was left alone, not to replace it.
--
-- Sub-markets (BTTS, Over/Under) go first, in their own pass, so a parent is
-- only removed once every child under it is either already gone or was never
-- eligible in the first place — never leaving a market with a phantom child
-- still on the board.

-- LANGUAGE plpgsql, not sql. A `sql`-language function is parsed and bound
-- against the catalog at CREATE time, so this would fail to load on any
-- database where the five tables it names do not all already exist — plpgsql
-- defers that to first call, which is what every other function in this
-- codebase relies on when it references tables created by a later migration.
CREATE OR REPLACE FUNCTION public._auto_fetched_market_has_activity(p_market_id bigint)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.user_bets            WHERE market_id = p_market_id)
      OR EXISTS (SELECT 1 FROM public.multiplier_legs      WHERE market_id = p_market_id)
      OR EXISTS (SELECT 1 FROM public.vip_referral_earnings WHERE market_id = p_market_id)
      OR EXISTS (SELECT 1 FROM public.bet_insurance_events  WHERE market_id = p_market_id)
      OR EXISTS (SELECT 1 FROM public.merkle_commits        WHERE market_id = p_market_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_unstaked_auto_fetched_markets(p_dry_run boolean DEFAULT true)
RETURNS TABLE (
  phase              text,
  candidates         integer,
  deleted            integer,
  blocked_by_fk      integer,
  sample_ids         bigint[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id           bigint;
  v_deleted      integer;
  v_blocked      integer;
  v_blocked_ids  bigint[];
BEGIN
  -- ── Phase 1: sub-markets ────────────────────────────────────────────────
  v_deleted := 0; v_blocked := 0; v_blocked_ids := '{}';
  FOR v_id IN
    SELECT m.id FROM public.markets m
     WHERE m.fixture_id IS NOT NULL
       AND m.parent_market_id IS NOT NULL
       AND NOT public._auto_fetched_market_has_activity(m.id)
     ORDER BY m.id
  LOOP
    IF p_dry_run THEN
      v_deleted := v_deleted + 1;
      CONTINUE;
    END IF;
    BEGIN
      DELETE FROM public.markets WHERE id = v_id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      -- Something references this row that the five checks above did not
      -- know to look for. Skip it and report it rather than let one
      -- surprise abort the whole pass — a table added after this migration
      -- shipped is exactly the kind of thing this guards against.
      v_blocked := v_blocked + 1;
      IF array_length(v_blocked_ids, 1) IS NULL OR array_length(v_blocked_ids, 1) < 20 THEN
        v_blocked_ids := v_blocked_ids || v_id;
      END IF;
    END;
  END LOOP;
  RETURN QUERY SELECT 'sub-markets'::text, v_deleted + v_blocked, v_deleted, v_blocked, v_blocked_ids;

  -- ── Phase 2: parents — only once every child is gone or was never
  -- eligible. Checked as "no child WITH activity remains", not "no child
  -- row remains", so this reads correctly in a dry run too, where phase 1
  -- deleted nothing yet.
  v_deleted := 0; v_blocked := 0; v_blocked_ids := '{}';
  FOR v_id IN
    SELECT m.id FROM public.markets m
     WHERE m.fixture_id IS NOT NULL
       AND m.parent_market_id IS NULL
       AND NOT public._auto_fetched_market_has_activity(m.id)
       AND NOT EXISTS (
             SELECT 1 FROM public.markets c
              WHERE c.parent_market_id = m.id
                AND (public._auto_fetched_market_has_activity(c.id) OR p_dry_run)
           )
     ORDER BY m.id
  LOOP
    IF p_dry_run THEN
      v_deleted := v_deleted + 1;
      CONTINUE;
    END IF;
    BEGIN
      DELETE FROM public.markets WHERE id = v_id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      v_blocked := v_blocked + 1;
      IF array_length(v_blocked_ids, 1) IS NULL OR array_length(v_blocked_ids, 1) < 20 THEN
        v_blocked_ids := v_blocked_ids || v_id;
      END IF;
    END;
  END LOOP;
  RETURN QUERY SELECT 'parents'::text, v_deleted + v_blocked, v_deleted, v_blocked, v_blocked_ids;

  -- ── Phase 3: what is left, and why ──────────────────────────────────────
  -- Not touched. These are the ones with real activity — they belong to the
  -- resolve cron, which already resolves and pays out every locked-odds
  -- sports market regardless of league, on its normal 5-minute schedule.
  RETURN QUERY
    SELECT 'left in place — has real activity'::text,
           count(*)::integer, 0, count(*)::integer,
           COALESCE((array_agg(m.id ORDER BY m.id))[1:20], '{}'::bigint[])
      FROM public.markets m
     WHERE m.fixture_id IS NOT NULL
       AND public._auto_fetched_market_has_activity(m.id);
END;
$$;

REVOKE ALL ON FUNCTION public.purge_unstaked_auto_fetched_markets(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_unstaked_auto_fetched_markets(boolean) TO service_role;
REVOKE ALL ON FUNCTION public._auto_fetched_market_has_activity(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._auto_fetched_market_has_activity(bigint) TO service_role;

NOTIFY pgrst, 'reload schema';
