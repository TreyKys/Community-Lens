-- ============================================================================
-- The Run — resolution, settlement, cash-out, void
-- ============================================================================
-- A leg resolves each week. Entries revalue as they go; when the fifth lands
-- the card settles and winners are paid. A player may exit early for the
-- expected value of their position, less the card's spread.
--
-- IN-PLAY CASH-OUT — the loophole this closes
--   A leg kicks off at 3pm and resolves at 5pm. In those two hours a player
--   watching the match knows strictly more than the model does: if their side
--   is losing they can cash out BEFORE the miss waters their position down,
--   which is a free option written against the house. So cash-out is locked
--   the moment any unresolved leg has kicked off, and reopens once it is
--   graded. Without this the spread is irrelevant — the player simply never
--   exits at a bad price.
-- ============================================================================

-- ── Resolve one leg ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_run_leg(
  p_run_id    uuid,
  p_leg_index smallint,
  p_result    text
)
RETURNS TABLE (applied boolean, reason text, legs_resolved integer, all_resolved boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_leg   public.run_legs%ROWTYPE;
  v_run   public.runs%ROWTYPE;
  v_done  integer;
BEGIN
  IF p_result NOT IN ('W','D','L') THEN
    RETURN QUERY SELECT false,'bad_result',0,false; RETURN;
  END IF;

  SELECT * INTO v_run FROM public.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'run_not_found',0,false; RETURN; END IF;
  IF v_run.status NOT IN ('open','live') THEN
    RETURN QUERY SELECT false,'run_not_live ('||v_run.status||')',0,false; RETURN;
  END IF;

  SELECT * INTO v_leg FROM public.run_legs
   WHERE run_id = p_run_id AND leg_index = p_leg_index FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'leg_not_found',0,false; RETURN; END IF;
  -- Grading is one-way. Re-grading a leg would silently reprice every live
  -- entry on the card, including ones already paid.
  IF v_leg.result IS NOT NULL THEN
    RETURN QUERY SELECT false,'already_resolved',0,false; RETURN;
  END IF;

  UPDATE public.run_legs
     SET result = p_result, resolved_at = now()
   WHERE run_id = p_run_id AND leg_index = p_leg_index;

  -- First graded leg takes the card live: no new entries from here.
  UPDATE public.runs SET status = 'live'
   WHERE id = p_run_id AND status = 'open';

  SELECT COUNT(*) INTO v_done FROM public.run_legs
   WHERE run_id = p_run_id AND result IS NOT NULL;

  RETURN QUERY SELECT true,'resolved',v_done,(v_done >= 5);
END;
$$;

-- ── Settle the card ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_run(
  p_run_id  uuid,
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, entries integer, winners integer, paid_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run     public.runs%ROWTYPE;
  v_done    integer;
  v_row     record;
  v_mult    numeric;
  v_pay     numeric;
  v_n       integer := 0;
  v_win     integer := 0;
  v_total   numeric := 0;
BEGIN
  SELECT * INTO v_run FROM public.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'run_not_found',0,0,0::numeric; RETURN; END IF;
  IF v_run.status = 'settled' THEN
    RETURN QUERY SELECT false,'already_settled',0,0,0::numeric; RETURN;
  END IF;
  IF v_run.status = 'void' THEN
    RETURN QUERY SELECT false,'run_void',0,0,0::numeric; RETURN;
  END IF;

  SELECT COUNT(*) INTO v_done FROM public.run_legs
   WHERE run_id = p_run_id AND result IS NOT NULL;
  IF v_done < 5 THEN
    RETURN QUERY SELECT false,'legs_outstanding ('||v_done||'/5)',0,0,0::numeric; RETURN;
  END IF;

  FOR v_row IN
    SELECT id, user_id, net_stake_tngn, payout_cap_tngn
      FROM public.run_entries
     WHERE run_id = p_run_id AND status = 'live'
     ORDER BY created_at
  LOOP
    v_n := v_n + 1;
    v_mult := public.run_entry_value(v_row.id, true);
    v_pay  := LEAST(round(v_row.net_stake_tngn * v_mult, 2), v_row.payout_cap_tngn);
    IF v_pay > 0 THEN
      v_win := v_win + 1;
      v_total := v_total + v_pay;
    END IF;

    IF NOT p_dry_run THEN
      IF v_pay > 0 THEN
        PERFORM public.credit_user(v_row.user_id, v_pay, 0);
      END IF;
      UPDATE public.run_entries
         SET status='settled', payout_tngn=v_pay, settled_at=now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;

  IF p_dry_run THEN
    RETURN QUERY SELECT false,'dry_run',v_n,v_win,v_total; RETURN;
  END IF;

  UPDATE public.runs SET status='settled', settled_at=now() WHERE id = p_run_id;
  RETURN QUERY SELECT true,'settled',v_n,v_win,v_total;
END;
$$;

-- ── Cash out early ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cash_out_run_entry(
  p_entry_id uuid,
  p_user_id  uuid,
  p_dry_run  boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, value_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_e     public.run_entries%ROWTYPE;
  v_run   public.runs%ROWTYPE;
  v_open  integer;
  v_live  integer;
  v_mult  numeric;
  v_val   numeric;
BEGIN
  SELECT * INTO v_e FROM public.run_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'entry_not_found',0::numeric; RETURN; END IF;
  IF v_e.user_id <> p_user_id THEN
    RETURN QUERY SELECT false,'not_your_entry',0::numeric; RETURN;
  END IF;
  IF v_e.status <> 'live' THEN
    RETURN QUERY SELECT false,'entry_'||v_e.status,0::numeric; RETURN;
  END IF;

  SELECT * INTO v_run FROM public.runs WHERE id = v_e.run_id;
  IF v_run.status = 'void' THEN
    RETURN QUERY SELECT false,'run_void',0::numeric; RETURN;
  END IF;

  SELECT COUNT(*) INTO v_open FROM public.run_legs
   WHERE run_id = v_e.run_id AND result IS NULL;
  -- Nothing left to be uncertain about: settlement is the correct path.
  IF v_open = 0 THEN
    RETURN QUERY SELECT false,'all_legs_resolved_settle_instead',0::numeric; RETURN;
  END IF;

  -- In-play lock: an ungraded leg that has already kicked off means the
  -- player can see what the model cannot.
  SELECT COUNT(*) INTO v_live FROM public.run_legs
   WHERE run_id = v_e.run_id AND result IS NULL
     AND kickoff_at IS NOT NULL AND kickoff_at <= now();
  IF v_live > 0 THEN
    RETURN QUERY SELECT false,'in_play_locked',0::numeric; RETURN;
  END IF;

  v_mult := public.run_entry_value(p_entry_id, false);      -- expected value
  v_val  := round(v_e.net_stake_tngn * v_mult * (1 - v_run.cashout_spread_pct), 2);
  v_val  := LEAST(v_val, v_e.payout_cap_tngn);
  IF v_val < 0 THEN v_val := 0; END IF;

  IF p_dry_run THEN
    RETURN QUERY SELECT false,'dry_run',v_val; RETURN;
  END IF;

  IF v_val > 0 THEN
    PERFORM public.credit_user(v_e.user_id, v_val, 0);
  END IF;
  UPDATE public.run_entries
     SET status='cashed_out', cashed_out_tngn=v_val, cashed_out_at=now()
   WHERE id = p_entry_id;

  RETURN QUERY SELECT true,'cashed_out',v_val;
END;
$$;

-- ── Void the card (refund stakes) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.void_run(
  p_run_id  uuid,
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, refunded integer, refunded_tngn numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.runs%ROWTYPE;
  v_row record;
  v_n   integer := 0;
  v_tot numeric := 0;
BEGIN
  SELECT * INTO v_run FROM public.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'run_not_found',0,0::numeric; RETURN; END IF;
  IF v_run.status IN ('settled','void') THEN
    RETURN QUERY SELECT false,'run_'||v_run.status,0,0::numeric; RETURN;
  END IF;

  FOR v_row IN
    SELECT id, user_id, stake_tngn FROM public.run_entries
     WHERE run_id = p_run_id AND status = 'live'
  LOOP
    v_n := v_n + 1; v_tot := v_tot + v_row.stake_tngn;
    IF NOT p_dry_run THEN
      PERFORM public.credit_user(v_row.user_id, v_row.stake_tngn, 0);
      UPDATE public.run_entries SET status='void', settled_at=now() WHERE id = v_row.id;
    END IF;
  END LOOP;

  IF p_dry_run THEN RETURN QUERY SELECT false,'dry_run',v_n,v_tot; RETURN; END IF;
  UPDATE public.runs SET status='void', settled_at=now() WHERE id = p_run_id;
  RETURN QUERY SELECT true,'voided',v_n,v_tot;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_run_leg(uuid,smallint,text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_run(uuid,boolean)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_out_run_entry(uuid,uuid,boolean)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_run(uuid,boolean)                     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_run_leg(uuid,smallint,text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_run(uuid,boolean)                TO service_role;
GRANT EXECUTE ON FUNCTION public.cash_out_run_entry(uuid,uuid,boolean)   TO service_role;
GRANT EXECUTE ON FUNCTION public.void_run(uuid,boolean)                  TO service_role;

NOTIFY pgrst, 'reload schema';
