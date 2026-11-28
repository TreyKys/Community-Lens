-- ============================================================================
-- The Run — placement
-- ============================================================================
-- One RPC, one transaction: validate, price, enforce every guardrail, debit,
-- write the entry. The guardrails live HERE and not in the API route, because
-- the route is one caller among several and the card liability cap is the only
-- thing standing between a hot card and the reserve.
--
-- Entry rake: the platform's standard 1.5% is taken on the way in, matching
-- single bets and Multiplier so treasury accounting stays uniform. Payout is
-- computed on the NET stake, so the effective return to player is
-- rtp_target x (1 - 0.015) — 0.886 at a 0.90 target. Stated plainly so nobody
-- later reads "RTP 0.90" off the runs table and believes it to the kobo.
--
-- Liability. An entry's worst case for the house is the player hitting all
-- five: net_stake x coefficient x Π(all picked odds), capped. We sum that
-- across every live entry on the card and refuse once it would cross
-- card_liability_cap_tngn. The card shuts to new entries at that point — the
-- better it sells, the sooner it closes. That is the intended behaviour: the
-- simulated worst week went from -N715,833 to -N100,000 on the back of it,
-- while the median week moved by N159.
--
-- Per-user total stake on one card is capped at max_stake_tngn as well, or ten
-- entries of the maximum would walk straight around the per-entry limit.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.place_run_entry(
  p_user_id uuid,
  p_run_id  uuid,
  p_stake   numeric,
  p_picks   jsonb          -- [{"leg_index":0,"pick":"W"}, ... x5]
)
RETURNS TABLE (
  entry_id        uuid,
  coefficient     numeric,
  max_payout_tngn numeric,
  net_stake_tngn  numeric,
  new_tngn        numeric,
  new_bonus       numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_entry_rake constant numeric := 0.015;
  v_run        public.runs%ROWTYPE;
  v_leg        public.run_legs%ROWTYPE;
  v_pick       text;
  v_idx        integer;
  v_odds       numeric;
  v_or         numeric;
  v_odds_arr   numeric[] := '{}';
  v_or_arr     numeric[] := '{}';
  v_prod       numeric := 1;
  v_k          numeric;
  v_net        numeric;
  v_rake       numeric;
  v_max_payout numeric;
  v_liability  numeric;
  v_user_stake numeric;
  v_real       numeric;
  v_bonus      numeric;
  v_from_bonus numeric;
  v_entry      uuid;
  v_count      integer;
BEGIN
  -- ── the card ─────────────────────────────────────────────────────────
  SELECT * INTO v_run FROM public.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run_not_found' USING ERRCODE='P0001'; END IF;
  IF v_run.status <> 'open' THEN
    RAISE EXCEPTION 'run_not_open' USING ERRCODE='P0001';
  END IF;
  IF v_run.closes_at <= now() THEN
    RAISE EXCEPTION 'run_closed' USING ERRCODE='P0001';
  END IF;

  -- ── stake ────────────────────────────────────────────────────────────
  IF p_stake IS NULL OR p_stake < v_run.min_stake_tngn THEN
    RAISE EXCEPTION 'stake_below_min' USING ERRCODE='P0001';
  END IF;
  IF p_stake > v_run.max_stake_tngn THEN
    RAISE EXCEPTION 'stake_above_max' USING ERRCODE='P0001';
  END IF;

  -- Per-user total on this card, so repeat entries cannot defeat the cap.
  SELECT COALESCE(SUM(stake_tngn),0) INTO v_user_stake
    FROM public.run_entries
   WHERE run_id = p_run_id AND user_id = p_user_id AND status <> 'void';
  IF v_user_stake + p_stake > v_run.max_stake_tngn THEN
    RAISE EXCEPTION 'user_stake_cap' USING ERRCODE='P0001';
  END IF;

  -- ── picks: exactly one per leg, all five, each a real cell ───────────
  IF jsonb_typeof(p_picks) <> 'array' OR jsonb_array_length(p_picks) <> 5 THEN
    RAISE EXCEPTION 'need_five_picks' USING ERRCODE='P0001';
  END IF;

  SELECT COUNT(DISTINCT (e->>'leg_index')::int) INTO v_count
    FROM jsonb_array_elements(p_picks) e;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'duplicate_leg' USING ERRCODE='P0001';
  END IF;

  FOR v_idx IN 0..4 LOOP
    SELECT e->>'pick' INTO v_pick
      FROM jsonb_array_elements(p_picks) e
     WHERE (e->>'leg_index')::int = v_idx;
    IF v_pick IS NULL OR v_pick NOT IN ('W','D','L') THEN
      RAISE EXCEPTION 'bad_pick' USING ERRCODE='P0001';
    END IF;

    SELECT * INTO v_leg FROM public.run_legs
     WHERE run_id = p_run_id AND leg_index = v_idx;
    IF NOT FOUND THEN RAISE EXCEPTION 'leg_missing' USING ERRCODE='P0001'; END IF;
    -- A leg that already kicked off cannot be picked.
    IF v_leg.result IS NOT NULL THEN
      RAISE EXCEPTION 'leg_already_resolved' USING ERRCODE='P0001';
    END IF;

    v_odds := CASE v_pick WHEN 'W' THEN v_leg.odds_w
                          WHEN 'D' THEN v_leg.odds_d
                          ELSE v_leg.odds_l END;
    v_or   := (1.0/v_leg.odds_w) + (1.0/v_leg.odds_d) + (1.0/v_leg.odds_l);

    v_odds_arr := array_append(v_odds_arr, v_odds);
    v_or_arr   := array_append(v_or_arr, v_or);
    v_prod     := v_prod * v_odds;
  END LOOP;

  -- ── price it ─────────────────────────────────────────────────────────
  v_rake := round(p_stake * c_entry_rake, 4);
  v_net  := p_stake - v_rake;
  v_k    := public.run_coefficient(v_odds_arr, v_or_arr, v_run.rtp_target, v_run.decay);

  -- Worst case for the house on this entry: every leg lands.
  v_max_payout := LEAST(
    v_net * v_k * v_prod,
    v_run.payout_cap_tngn,
    v_net * v_run.payout_cap_multiple
  );

  -- ── card liability cap — the guardrail that actually matters ─────────
  SELECT COALESCE(SUM(
           LEAST(
             e.net_stake_tngn * e.coefficient * (
               SELECT COALESCE(EXP(SUM(LN(pk.odds))),1)
                 FROM public.run_entry_picks pk WHERE pk.entry_id = e.id
             ),
             e.payout_cap_tngn
           )
         ),0)
    INTO v_liability
    FROM public.run_entries e
   WHERE e.run_id = p_run_id AND e.status = 'live';

  IF v_liability + v_max_payout > v_run.card_liability_cap_tngn THEN
    RAISE EXCEPTION 'card_liability_cap' USING ERRCODE='P0001';
  END IF;

  -- ── funds: cash first, then bonus (same order as Multiplier) ─────────
  SELECT COALESCE(tngn_balance,0), COALESCE(bonus_balance,0)
    INTO v_real, v_bonus
    FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE='P0001'; END IF;
  IF v_real + v_bonus < p_stake THEN
    RAISE EXCEPTION 'insufficient_balance' USING ERRCODE='P0001';
  END IF;

  IF v_real >= p_stake THEN
    v_real := v_real - p_stake;
    v_from_bonus := 0;
  ELSE
    v_from_bonus := p_stake - v_real;
    v_bonus := v_bonus - v_from_bonus;
    v_real  := 0;
  END IF;

  UPDATE public.users
     SET tngn_balance = v_real, bonus_balance = v_bonus
   WHERE id = p_user_id;

  -- ── write it ─────────────────────────────────────────────────────────
  INSERT INTO public.run_entries
    (run_id, user_id, stake_tngn, net_stake_tngn, coefficient, decay,
     payout_cap_tngn, status)
  VALUES
    (p_run_id, p_user_id, p_stake, v_net, v_k, v_run.decay,
     LEAST(v_run.payout_cap_tngn, v_net * v_run.payout_cap_multiple), 'live')
  RETURNING id INTO v_entry;

  INSERT INTO public.run_entry_picks (entry_id, leg_index, pick, odds)
  SELECT v_entry,
         (e->>'leg_index')::smallint,
         e->>'pick',
         v_odds_arr[(e->>'leg_index')::int + 1]
    FROM jsonb_array_elements(p_picks) e;

  RETURN QUERY SELECT v_entry, v_k, v_max_payout, v_net, v_real, v_bonus;
END;
$$;

REVOKE ALL ON FUNCTION public.place_run_entry(uuid,uuid,numeric,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_run_entry(uuid,uuid,numeric,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
