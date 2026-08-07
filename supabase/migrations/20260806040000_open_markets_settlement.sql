-- ============================================================================
-- Open Markets — settlement, void, retire, and the payer
-- ============================================================================
-- Every payout here is TWO phases, never one:
--
--   Phase A  work out what everyone is owed, write it down, pay nobody.
--   Phase B  actually pay, after the dispute window, resumably.
--
-- Why the split matters more than it looks:
--
--  * Phase A is set-based and touches only the market row. Settling 900
--    positions is three statements and milliseconds. A single loop calling
--    credit_user 900 times would hold the market lock plus 900 user row locks
--    for the whole run, blocking every trader and deadlocking against anything
--    that locks users first.
--
--  * Money that is already in a withdrawable balance cannot be clawed back —
--    reclaim_slip_bonus_split has a `shortfall` column precisely because that
--    lesson was learned the expensive way. So a dispute window is decorative
--    unless the payout is HELD, not paid and then regretted.
--
--  * Phase B is resumable. If it dies at position 400 of 900, rows 1-400 are
--    committed with released_at stamped, and that stamp IS the cursor. The
--    retry starts at 401. No double payment is possible because the credit and
--    the stamp share one subtransaction.
-- ============================================================================

-- ── Phase A: resolve. Computes, never pays. ────────────────────────────────
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

-- ── Phase A: void / retire. Pro-rata by default. ───────────────────────────
-- Pro-rata is exact ONLY because this unwinds the WHOLE book — every holder is
-- paid and q goes to zero, so the distribution is exactly what was collected.
-- (Paying a subset pro-rata silently taxes whoever stays; that is why the
-- horizon uses ordinary sells instead.)
--
-- 'cost_basis' refunds what people paid in. That is NOT a policy choice, it is
-- an unbounded liability: if someone bought high and someone else already
-- exited at a profit, the pool no longer contains their cost. So it is gated
-- behind house_fault plus two approvers, and the gap is an explicit, logged
-- treasury top-up rather than something quietly netted off the pool.
CREATE OR REPLACE FUNCTION public.void_open_market(
  p_market_id   uuid,
  p_kind        text,      -- 'operational' | 'house_fault'
  p_basis       text,      -- 'pro_rata' | 'cost_basis'
  p_requested_by uuid,
  p_approved_by  uuid,
  p_reason      text,
  p_dry_run     boolean DEFAULT true
)
RETURNS TABLE (applied boolean, reason text, positions integer,
               pool_tngn numeric, gross_tngn numeric, house_topup_tngn numeric,
               locked_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt   public.open_markets%ROWTYPE;
  v_epoch smallint;
  v_pool  numeric;
  v_w     numeric;
  v_pos   integer;
  v_gross numeric;
  v_until timestamptz;
  v_prices numeric[];
BEGIN
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'not_found',0,0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
  END IF;
  IF v_mkt.status NOT IN ('open','closed','halted','horizon_window') THEN
    RETURN QUERY SELECT false,'cannot void from status ' || v_mkt.status,0,
                        0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
  END IF;
  IF p_basis NOT IN ('pro_rata','cost_basis') THEN
    RETURN QUERY SELECT false,'bad basis',0,0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
  END IF;
  IF p_basis = 'cost_basis' THEN
    IF p_kind <> 'house_fault' THEN
      RETURN QUERY SELECT false,'cost_basis requires void_kind=house_fault',0,
                          0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
    END IF;
    IF p_approved_by IS NULL OR p_approved_by = p_requested_by THEN
      RETURN QUERY SELECT false,'cost_basis requires a second approver',0,
                          0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
    END IF;
  END IF;

  v_epoch := COALESCE((SELECT MAX(epoch) FROM public.open_settlements
                        WHERE market_id = p_market_id AND kind = 'void'), -1) + 1;
  v_pool   := public.lmsr_cost(v_mkt.q, v_mkt.b) - public.lmsr_cost(v_mkt.q_initial, v_mkt.b);
  v_prices := public.lmsr_prices(v_mkt.q, v_mkt.b);

  SELECT COUNT(*), COALESCE(SUM((shares_cash + shares_bonus) * v_prices[outcome_idx + 1]), 0)
    INTO v_pos, v_w
    FROM public.open_positions
   WHERE market_id = p_market_id AND status = 'open' AND (shares_cash + shares_bonus) > 0;

  IF p_basis = 'cost_basis' THEN
    SELECT COALESCE(SUM(cost_cash + cost_bonus), 0) INTO v_gross
      FROM public.open_positions
     WHERE market_id = p_market_id AND status = 'open' AND (shares_cash + shares_bonus) > 0;
  ELSE
    v_gross := LEAST(v_pool, v_w);
  END IF;

  v_until := now() + make_interval(hours => v_mkt.dispute_window_hours);

  IF p_dry_run THEN
    RETURN QUERY SELECT false,'dry_run',v_pos,v_pool,v_gross,
                        GREATEST(v_gross - v_pool, 0), v_until; RETURN;
  END IF;

  IF p_basis = 'pro_rata' THEN
    INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn)
    SELECT p.id, p.market_id, 'void', v_epoch, 'pro_rata',
           -- floor: the rounding residual stays with the house, so the
           -- distribution can never exceed the pool it is dividing
           floor(v_pool * ((p.shares_cash + p.shares_bonus) * v_prices[p.outcome_idx + 1])
                 / NULLIF(v_w, 0) * 100) / 100
      FROM public.open_positions p
     WHERE p.market_id = p_market_id AND p.status = 'open'
       AND (p.shares_cash + p.shares_bonus) > 0;
  ELSE
    INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn, bonus)
    SELECT p.id, p.market_id, 'void', v_epoch, 'cost_basis', p.cost_cash, p.cost_bonus
      FROM public.open_positions p
     WHERE p.market_id = p_market_id AND p.status = 'open'
       AND (p.shares_cash + p.shares_bonus) > 0;
    -- The shortfall is real house money and is booked as a named loss, not
    -- hidden inside the pool arithmetic.
    IF v_gross > v_pool THEN
      INSERT INTO public.treasury_log (type, amount_tngn, open_market_id, metadata)
      VALUES ('open_void_house_topup', -(v_gross - v_pool), p_market_id,
              jsonb_build_object('reason', p_reason, 'requested_by', p_requested_by,
                                 'approved_by', p_approved_by));
    END IF;
  END IF;

  UPDATE public.open_positions SET status = 'refunded', settled_at = now()
   WHERE market_id = p_market_id AND status = 'open';

  UPDATE public.open_markets
     SET status = 'pending_payout', pending_kind = 'void', payout_phase = 'computed',
         void_kind = p_kind, settlement_locked_until = v_until,
         max_hold_until = now() + interval '14 days'
   WHERE id = p_market_id;

  RETURN QUERY SELECT true,'computed',v_pos,v_pool,v_gross,
                      GREATEST(v_gross - v_pool, 0), v_until;
END;
$$;

-- ── Phase B: the payer. The ONLY thing that credits a wallet. ──────────────
CREATE OR REPLACE FUNCTION public.release_open_settlements(
  p_market_id uuid,
  p_limit     integer DEFAULT 250,
  p_force     boolean DEFAULT false
)
RETURNS TABLE (released integer, failed integer, remaining integer, finished boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mkt public.open_markets%ROWTYPE;
  v_row record;
  v_ok  integer := 0;
  v_bad integer := 0;
  v_left integer;
  v_stuck integer;
BEGIN
  -- Deliberately NO market lock. Phase A already flipped the status under one,
  -- so no trader can touch this book — and taking it here would collide with
  -- the user locks below.
  SELECT * INTO v_mkt FROM public.open_markets WHERE id = p_market_id;
  IF NOT FOUND OR v_mkt.status <> 'pending_payout' THEN
    RAISE EXCEPTION 'market not pending_payout' USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_force THEN
    IF v_mkt.settlement_locked_until IS NOT NULL AND now() < v_mkt.settlement_locked_until THEN
      RAISE EXCEPTION 'dispute window open until %', v_mkt.settlement_locked_until
        USING ERRCODE = 'P0001';
    END IF;
    IF v_mkt.halted_at IS NOT NULL THEN
      RAISE EXCEPTION 'market halted' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.open_market_disputes
                WHERE market_id = p_market_id AND status = 'open') THEN
      RAISE EXCEPTION 'open dispute blocks release' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.open_markets SET payout_phase = 'releasing'
   WHERE id = p_market_id AND payout_phase = 'computed';

  FOR v_row IN
    SELECT s.id, s.tngn, s.bonus, p.user_id
      FROM public.open_settlements s
      JOIN public.open_positions p ON p.id = s.position_id
     WHERE s.market_id = p_market_id AND s.released_at IS NULL AND s.attempts < 5
     ORDER BY p.user_id, s.id          -- stable lock order against other flows
     LIMIT p_limit
     FOR UPDATE OF s SKIP LOCKED       -- two workers never collide
  LOOP
    BEGIN
      -- BEGIN/EXCEPTION here is a SUBTRANSACTION: one poison row rolls back
      -- alone and the batch carries on. Without it, a single deleted user
      -- strands every other payout on the market.
      IF v_row.tngn <> 0 OR v_row.bonus <> 0 THEN
        PERFORM public.credit_user(v_row.user_id, v_row.tngn, v_row.bonus);
      END IF;
      UPDATE public.open_settlements
         SET released_at = now(), attempts = attempts + 1 WHERE id = v_row.id;
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.open_settlements
         SET attempts = attempts + 1, failed_at = now(), last_error = SQLERRM
       WHERE id = v_row.id;
      v_bad := v_bad + 1;
    END;
  END LOOP;

  SELECT COUNT(*) FILTER (WHERE attempts < 5), COUNT(*)
    INTO v_left, v_stuck
    FROM public.open_settlements
   WHERE market_id = p_market_id AND released_at IS NULL;

  IF v_stuck = 0 THEN
    UPDATE public.open_markets
       SET status = CASE pending_kind WHEN 'resolve' THEN 'resolved'
                                      WHEN 'void'    THEN 'voided'
                                      ELSE 'retired' END,
           payout_phase = 'released'
     WHERE id = p_market_id AND status = 'pending_payout';
  END IF;

  RETURN QUERY SELECT v_ok, v_bad, v_left, (v_stuck = 0);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_open_market(uuid,integer,uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_open_market(uuid,text,text,uuid,uuid,text,boolean)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_open_settlements(uuid,integer,boolean)           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_open_market(uuid,integer,uuid,uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_open_market(uuid,text,text,uuid,uuid,text,boolean)  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_open_settlements(uuid,integer,boolean)           TO service_role;

NOTIFY pgrst, 'reload schema';
