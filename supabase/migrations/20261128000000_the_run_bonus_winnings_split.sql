-- The Run: apply the bonus / cash winnings split.
--
-- THE BUG. Every Run payout went to `credit_user(user, amount, 0)` — i.e.
-- 100% to withdrawable cash — regardless of how the stake was funded. Single
-- bets and Multiplier slips have run `bonus_winnings_split()` since
-- 20260630200000: a stake that was >=90% bonus credit pays 10% cash / 90%
-- bonus, >=80% pays 20/80, >=70% pays 30/70, below that pays all cash.
--
-- So The Run shipped with a hole the other two products don't have: claim the
-- free bonus rewards, put the whole lot on a Run, cash out, withdraw real
-- naira. Bonus credit is supposed to be stakeable-but-not-withdrawable; here
-- it was neither.
--
-- Also fixed here: place_run_entry was the only placement function in the
-- codebase that did not burn expired bonus before spending it, so bonus credit
-- past its 7-day expiry was still stakeable on a Run.
--
-- Fixed in all three exits — settlement, cash-out and void — by reusing the
-- SAME function the other products call, not by reimplementing the ladder.
-- If the tiers ever change, all three products change together.

-- ─── 1. record how the stake was funded ──────────────────────────────
ALTER TABLE public.run_entries
  ADD COLUMN IF NOT EXISTS bonus_proportion numeric NOT NULL DEFAULT 0;
ALTER TABLE public.run_entries
  DROP CONSTRAINT IF EXISTS run_entries_bonus_proportion_check;
ALTER TABLE public.run_entries
  ADD CONSTRAINT run_entries_bonus_proportion_check
  CHECK (bonus_proportion >= 0 AND bonus_proportion <= 1);

-- What of each exit landed back in bonus rather than cash. Kept separately so
-- payout_tngn / cashed_out_tngn keep meaning "total value of the exit", which
-- is what the player's history and the position readout display.
ALTER TABLE public.run_entries
  ADD COLUMN IF NOT EXISTS payout_bonus_tngn numeric NOT NULL DEFAULT 0;
ALTER TABLE public.run_entries
  ADD COLUMN IF NOT EXISTS cashed_out_bonus_tngn numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.run_entries.bonus_proportion IS
  'Fraction of stake_tngn funded from bonus_balance at placement. Feeds bonus_winnings_split() at settlement, cash-out and void.';

-- ─── 2. place_run_entry — persist it ─────────────────────
CREATE OR REPLACE FUNCTION public.place_run_entry(p_user_id uuid, p_run_id uuid, p_stake numeric, p_picks jsonb)
 RETURNS TABLE(entry_id uuid, coefficient numeric, max_payout_tngn numeric, net_stake_tngn numeric, new_tngn numeric, new_bonus numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_bonus_exp  timestamptz;
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
  SELECT COALESCE(tngn_balance,0), COALESCE(bonus_balance,0), bonus_expires_at
    INTO v_real, v_bonus, v_bonus_exp
    FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE='P0001'; END IF;

  -- Burn stale bonus before working out what is available. place_bet,
  -- place_bet_locked, place_multiplier_slip and execute_open_trade all do
  -- this; place_run_entry did not, which made The Run the one place expired
  -- bonus credit was still spendable.
  IF v_bonus > 0 AND v_bonus_exp IS NOT NULL AND v_bonus_exp <= now() THEN
    v_bonus := 0;
    UPDATE public.users SET bonus_balance = 0, bonus_expires_at = NULL WHERE id = p_user_id;
  END IF;

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
     payout_cap_tngn, status, bonus_proportion)
  VALUES
    (p_run_id, p_user_id, p_stake, v_net, v_k, v_run.decay,
     LEAST(v_run.payout_cap_tngn, v_net * v_run.payout_cap_multiple), 'live',
     -- How much of this stake came out of bonus credit. Decides, at payout
     -- time, how much of the winnings is withdrawable cash and how much
     -- goes back to bonus — same rule as single bets and Multiplier.
     CASE WHEN p_stake > 0 THEN round(v_from_bonus / p_stake, 6) ELSE 0 END)
  RETURNING id INTO v_entry;

  INSERT INTO public.run_entry_picks (entry_id, leg_index, pick, odds)
  SELECT v_entry,
         (e->>'leg_index')::smallint,
         e->>'pick',
         v_odds_arr[(e->>'leg_index')::int + 1]
    FROM jsonb_array_elements(p_picks) e;

  RETURN QUERY SELECT v_entry, v_k, v_max_payout, v_net, v_real, v_bonus;
END;
$function$;

-- ─── 3. settle_run — split the payout ────────────────────
CREATE OR REPLACE FUNCTION public.settle_run(p_run_id uuid, p_dry_run boolean DEFAULT true)
 RETURNS TABLE(applied boolean, reason text, entries integer, winners integer, paid_tngn numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run     public.runs%ROWTYPE;
  v_done    integer;
  v_row     record;
  v_mult    numeric;
  v_pay     numeric;
  v_split   record;
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
    SELECT id, user_id, net_stake_tngn, payout_cap_tngn, bonus_proportion
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
        -- Bonus-funded stakes do not pay out as withdrawable cash. A stake
        -- that was >=70% bonus credit pays 30/20/10% cash and the rest back
        -- as bonus, exactly as bonus_winnings_split decides for single bets
        -- and Multiplier slips. Crediting it all to cash would have turned
        -- free bonus credit into a withdrawal route.
        SELECT * INTO v_split
          FROM public.bonus_winnings_split(v_pay, COALESCE(v_row.bonus_proportion, 0));
        PERFORM public.credit_user(v_row.user_id, v_split.tngn_amount, v_split.bonus_amount);
      ELSE
        SELECT 0::numeric, 0::numeric INTO v_split;
      END IF;
      UPDATE public.run_entries
         SET status='settled', payout_tngn=v_pay,
             payout_bonus_tngn=COALESCE(v_split.bonus_amount, 0), settled_at=now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;

  IF p_dry_run THEN
    RETURN QUERY SELECT false,'dry_run',v_n,v_win,v_total; RETURN;
  END IF;

  UPDATE public.runs SET status='settled', settled_at=now() WHERE id = p_run_id;
  RETURN QUERY SELECT true,'settled',v_n,v_win,v_total;
END;
$function$;

-- ─── 4. cash_out_run_entry — split the cash-out ──────────
CREATE OR REPLACE FUNCTION public.cash_out_run_entry(p_entry_id uuid, p_user_id uuid, p_dry_run boolean DEFAULT true)
 RETURNS TABLE(applied boolean, reason text, value_tngn numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_e     public.run_entries%ROWTYPE;
  v_run   public.runs%ROWTYPE;
  v_open  integer;
  v_live  integer;
  v_mult  numeric;
  v_val   numeric;
  v_split record;
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

  -- Same split as settlement. Without it, cash-out is the shorter
  -- laundering route: fund an entry entirely from bonus credit, cash out
  -- minutes later at ~95%, withdraw real money.
  IF v_val > 0 THEN
    SELECT * INTO v_split
      FROM public.bonus_winnings_split(v_val, COALESCE(v_e.bonus_proportion, 0));
    PERFORM public.credit_user(v_e.user_id, v_split.tngn_amount, v_split.bonus_amount);
  ELSE
    SELECT 0::numeric, 0::numeric INTO v_split;
  END IF;
  UPDATE public.run_entries
     SET status='cashed_out', cashed_out_tngn=v_val,
         cashed_out_bonus_tngn=COALESCE(v_split.bonus_amount, 0), cashed_out_at=now()
   WHERE id = p_entry_id;

  RETURN QUERY SELECT true,'cashed_out',v_val;
END;
$function$;

-- ─── 5. void_run — refund in the original mix ────────────
CREATE OR REPLACE FUNCTION public.void_run(p_run_id uuid, p_dry_run boolean DEFAULT true)
 RETURNS TABLE(applied boolean, reason text, refunded integer, refunded_tngn numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
  v_row record;
  v_n   integer := 0;
  v_tot numeric := 0;
  v_bk  numeric;
BEGIN
  SELECT * INTO v_run FROM public.runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'run_not_found',0,0::numeric; RETURN; END IF;
  IF v_run.status IN ('settled','void') THEN
    RETURN QUERY SELECT false,'run_'||v_run.status,0,0::numeric; RETURN;
  END IF;

  FOR v_row IN
    SELECT id, user_id, stake_tngn, bonus_proportion FROM public.run_entries
     WHERE run_id = p_run_id AND status = 'live'
  LOOP
    v_n := v_n + 1; v_tot := v_tot + v_row.stake_tngn;
    IF NOT p_dry_run THEN
      -- A void is not a win, so the ladder does not apply: put the money
      -- back exactly as it came out, or a voided card would quietly convert
      -- bonus credit into cash.
      v_bk := round(v_row.stake_tngn * COALESCE(v_row.bonus_proportion, 0), 2);
      PERFORM public.credit_user(v_row.user_id, v_row.stake_tngn - v_bk, v_bk);
      UPDATE public.run_entries SET status='void', settled_at=now() WHERE id = v_row.id;
    END IF;
  END LOOP;

  IF p_dry_run THEN RETURN QUERY SELECT false,'dry_run',v_n,v_tot; RETURN; END IF;
  UPDATE public.runs SET status='void', settled_at=now() WHERE id = p_run_id;
  RETURN QUERY SELECT true,'voided',v_n,v_tot;
END;
$function$;

