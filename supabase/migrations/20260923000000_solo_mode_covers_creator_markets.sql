-- Solo operator mode: cover every market, not just house ones.
--
-- 20260807140000 built solo_operator_mode for exactly this platform's
-- reality — one admin, one shared secret, nobody to hand a second signature
-- to — but scoped the bypass to HOUSE markets only (created_by IS NULL).
-- Every market with a real creator still required two DISTINCT admin
-- identities to resolve or void it, which is the same impossible door on
-- the far more common case: most Open Markets have a real creator.
--
-- What actually protects other people's money is the creator (and
-- submitter) never being allowed to act as resolver or confirmer — that
-- check is unconditional below, exactly as before, solo mode or not. The
-- thing that bends is narrower than it looks: only whether the resolver and
-- confirmer must be two DIFFERENT admins. With solo mode on, the same
-- identity may now sign both roles on ANY market, not only a house one.
--
-- Both functions are lifted from their current live bodies (20260807140000
-- for settle_open_market, 20260911000000 for void_open_market) and patched
-- narrowly — a diff against those sources shows exactly the lines this
-- migration's own comment describes and nothing else.

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

  -- The creator, and whoever submitted it, can NEVER act as resolver or
  -- confirmer — solo mode or not. This is the actual insider-trading
  -- protection (someone deciding the payout on a book they earn a fee
  -- share on, or were allowed to trade), and it has nothing to do with how
  -- many admins exist, so it is checked first and unconditionally.
  IF p_resolved_by IS NOT NULL AND p_confirmed_by IS NOT NULL THEN
    IF v_mkt.created_by IS NOT NULL
       AND (p_resolved_by = v_mkt.created_by OR p_confirmed_by = v_mkt.created_by) THEN
      RETURN QUERY SELECT false, 'creator cannot resolve their own market',
                          0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
      RETURN;
    END IF;
    IF v_mkt.submitted_by IS NOT NULL
       AND (p_resolved_by = v_mkt.submitted_by OR p_confirmed_by = v_mkt.submitted_by) THEN
      RETURN QUERY SELECT false, 'whoever submitted this market cannot resolve it',
                          0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  IF p_resolved_by IS NULL OR p_confirmed_by IS NULL THEN
    RETURN QUERY SELECT false, 'needs an approver', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  -- The ONLY thing solo mode bends: whether resolver and confirmer must be
  -- two different people. Now applies to any market, not just a house one —
  -- the restriction to created_by IS NULL is gone; the checks above are what
  -- actually needed it, and they do not bend for anyone.
  IF v_cfg.solo_operator_mode THEN
    v_self_resolved := (p_resolved_by = p_confirmed_by);
  ELSIF p_resolved_by = p_confirmed_by THEN
    RETURN QUERY SELECT false, 'needs two distinct approvers', 0, 0, 0::numeric, 0::numeric, NULL::timestamptz;
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

REVOKE ALL ON FUNCTION public.settle_open_market(uuid,integer,uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_open_market(uuid,integer,uuid,uuid,text,boolean) TO service_role;

-- ── void_open_market ─────────────────────────────────────────────────────────
-- Only the cost_basis (house_fault) path ever required a second approver;
-- pro_rata voids never did. Solo mode now lets that one requirement bend
-- too, the same "same person, both roles" way settle_open_market's does.
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
  v_cfg   public.open_markets_config%ROWTYPE;
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
  SELECT * INTO v_cfg FROM public.open_markets_config WHERE id = 1;
  IF p_basis = 'cost_basis' THEN
    IF p_kind <> 'house_fault' THEN
      RETURN QUERY SELECT false,'cost_basis requires void_kind=house_fault',0,
                          0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
    END IF;
    IF p_approved_by IS NULL THEN
      RETURN QUERY SELECT false,'cost_basis requires an approver',0,
                          0::numeric,0::numeric,0::numeric,NULL::timestamptz; RETURN;
    END IF;
    IF NOT v_cfg.solo_operator_mode AND p_approved_by = p_requested_by THEN
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
    -- Split each position's pro-rata payout by the SAME mix its shares were
    -- bought in: bonus-funded shares pay into bonus, never tngn — a void
    -- must not become the cash-out laundering path a sell already refuses to
    -- be. floor() only bounds the TOTAL against the pool; the cash/bonus
    -- split itself loses nothing (bonus takes payout − floor(cash part), not
    -- a second floor), so tngn + bonus always equals the pool-bounded total.
    INSERT INTO public.open_settlements (position_id, market_id, kind, epoch, basis, tngn, bonus)
    SELECT p.id, p.market_id, 'void', v_epoch, 'pro_rata',
           floor(p.payout * p.cash_frac * 100) / 100,
           p.payout - floor(p.payout * p.cash_frac * 100) / 100
      FROM (
        SELECT pos.id, pos.market_id,
               floor(v_pool * ((pos.shares_cash + pos.shares_bonus) * v_prices[pos.outcome_idx + 1])
                     / NULLIF(v_w, 0) * 100) / 100 AS payout,
               CASE WHEN (pos.shares_cash + pos.shares_bonus) > 0
                    THEN pos.shares_cash / (pos.shares_cash + pos.shares_bonus)
                    ELSE 1 END AS cash_frac
          FROM public.open_positions pos
         WHERE pos.market_id = p_market_id AND pos.status = 'open'
           AND (pos.shares_cash + pos.shares_bonus) > 0
      ) p;
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

REVOKE ALL ON FUNCTION public.void_open_market(uuid,text,text,uuid,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_open_market(uuid,text,text,uuid,uuid,text,boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
