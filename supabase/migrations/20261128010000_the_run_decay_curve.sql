-- The Run: replace the flat decay with a decay CURVE.
--
-- WHAT CHANGES, AND WHY.
--
-- Until now a miss cost a constant factor (0.80), so the value of an entry was
--   k × Π(odds of legs hit) × decay^(legs missed)
-- and k solved in closed form because the per-leg expectations multiply out.
--
-- The brief: partial results below break-even should pay LESS, the full house
-- should pay MORE, and the break-even point should not move. A flat decay
-- cannot do that — one number controls the whole ladder, and lowering it drags
-- 3/5 and 4/5 down with 1/5 and 2/5.
--
-- A curve can. We now store the survival factor for each miss count
-- independently: curve[m] is the fraction of the full-house value an entry
-- keeps after m misses. Crush the deep end (3, 4, 5 misses), and k rises to
-- hold RTP at target, which lifts the whole ladder — then pull the shallow end
-- (1 and 2 misses) down by exactly that lift so 4/5 and 3/5 land where they
-- were. Net effect: 0/5, 1/5 and 2/5 fall ~40%, 5/5 rises ~48%, 3/5 and 4/5
-- are untouched, and the theoretical RTP is unchanged.
--
-- THE COST OF THIS, stated plainly: the decay curve is NOT separable across
-- legs. The survival factor depends on the TOTAL number of misses, so the
-- expectation over unresolved legs no longer factorises into a per-leg
-- product. Both the coefficient solve and the mid-card valuation have to
-- enumerate hit/miss patterns — at most 2^5 = 32, so the cost is trivial, but
-- the closed form is gone and cannot come back.
--
-- BACKWARD COMPATIBILITY. runs.decay and run_entries.decay stay. A NULL
-- decay_curve means "flat", and run_decay_curve() expands it to
-- [d, d², d³, d⁴, d⁵] — identical to the old behaviour. Every existing card,
-- every in-flight entry and every settled entry keeps the exact value it had.
-- Entries snapshot the curve at placement, so editing a card never re-prices
-- an entry that is already live.

-- ─── 1. storage ──────────────────────────────────────────────────────────
ALTER TABLE public.runs
  ADD COLUMN IF NOT EXISTS decay_curve numeric[];
ALTER TABLE public.run_entries
  ADD COLUMN IF NOT EXISTS decay_curve numeric[];

COMMENT ON COLUMN public.runs.decay_curve IS
  'Survival factor after 1..5 misses (5 elements, strictly decreasing, each in (0,1]). NULL = flat, derived from decay.';
COMMENT ON COLUMN public.run_entries.decay_curve IS
  'Curve snapshotted at placement. Editing the card never re-prices a live entry.';

-- ─── 2. normalise / validate a curve ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_decay_curve(p_decay numeric, p_curve numeric[])
RETURNS numeric[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  i integer;
BEGIN
  -- No curve set: expand the flat decay, which reproduces the old maths
  -- exactly. This is the path every pre-existing card takes.
  IF p_curve IS NULL OR array_length(p_curve, 1) IS NULL THEN
    IF p_decay IS NULL OR p_decay <= 0 OR p_decay > 1 THEN
      RAISE EXCEPTION 'run_decay_curve: decay must be in (0,1], got %', p_decay;
    END IF;
    RETURN ARRAY[p_decay, p_decay^2, p_decay^3, p_decay^4, p_decay^5];
  END IF;

  IF array_length(p_curve, 1) <> 5 THEN
    RAISE EXCEPTION 'run_decay_curve: curve needs exactly 5 elements, got %',
      array_length(p_curve, 1);
  END IF;

  FOR i IN 1..5 LOOP
    IF p_curve[i] IS NULL OR p_curve[i] <= 0 OR p_curve[i] > 1 THEN
      RAISE EXCEPTION 'run_decay_curve: element % must be in (0,1], got %', i, p_curve[i];
    END IF;
    -- Strictly decreasing, or an extra miss could be worth MORE than fewer
    -- misses — which a player would find before we did.
    IF i > 1 AND p_curve[i] >= p_curve[i-1] THEN
      RAISE EXCEPTION 'run_decay_curve: must strictly decrease (element % = %, element % = %)',
        i, p_curve[i], i-1, p_curve[i-1];
    END IF;
  END LOOP;

  RETURN p_curve;
END;
$$;

-- Survival factor after m misses. m = 0 is the full house and always 1.
CREATE OR REPLACE FUNCTION public.run_curve_at(p_curve numeric[], p_misses integer)
RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_misses <= 0 THEN 1::numeric ELSE p_curve[p_misses] END;
$$;

-- ─── 3. the coefficient, solved over all 32 patterns ─────────────────────
-- Same contract as run_coefficient: return k such that the expected value of
-- an entry is exactly p_rtp_target, given de-vigged per-leg probabilities.
-- The old closed form summed a product of per-leg expectations; with a curve
-- the survival factor couples the legs, so we sum over patterns instead.
CREATE OR REPLACE FUNCTION public.run_coefficient_curve(
  p_odds numeric[], p_overrounds numeric[], p_rtp_target numeric, p_curve numeric[])
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_n     integer := array_length(p_odds, 1);
  v_p     numeric[] := '{}';
  v_mask  integer;
  v_i     integer;
  v_prob  numeric;
  v_w     numeric;
  v_miss  integer;
  v_sum   numeric := 0;
BEGIN
  IF v_n IS DISTINCT FROM array_length(p_overrounds, 1) THEN
    RAISE EXCEPTION 'run_coefficient_curve: odds/overround length mismatch';
  END IF;
  IF v_n IS NULL OR v_n < 1 OR v_n > 5 THEN
    RAISE EXCEPTION 'run_coefficient_curve: needs 1..5 legs, got %', v_n;
  END IF;

  FOR v_i IN 1..v_n LOOP
    v_p := array_append(v_p, (1.0 / p_odds[v_i]) / p_overrounds[v_i]);
  END LOOP;

  FOR v_mask IN 0 .. ((1 << v_n) - 1) LOOP
    v_prob := 1; v_w := 1; v_miss := 0;
    FOR v_i IN 1..v_n LOOP
      IF ((v_mask >> (v_i - 1)) & 1) = 1 THEN          -- this leg hit
        v_prob := v_prob * v_p[v_i];
        v_w    := v_w * p_odds[v_i];
      ELSE                                              -- this leg missed
        v_prob := v_prob * (1 - v_p[v_i]);
        v_miss := v_miss + 1;
      END IF;
    END LOOP;
    v_sum := v_sum + v_prob * v_w * public.run_curve_at(p_curve, v_miss);
  END LOOP;

  IF v_sum <= 0 THEN
    RAISE EXCEPTION 'run_coefficient_curve: non-positive expectation';
  END IF;
  RETURN p_rtp_target / v_sum;
END;
$$;

-- ─── 4. entry valuation, curve-aware ────────────────────────────────────
-- p_settled_only = true  → realised value: unresolved legs contribute x1 and
--                          are not counted as misses (settlement basis).
-- p_settled_only = false → cash-out basis: unresolved legs carried at
--                          expectation. With a curve that expectation couples
--                          the legs, so we enumerate the unresolved subset.
CREATE OR REPLACE FUNCTION public.run_entry_value(p_entry_id uuid, p_settled_only boolean DEFAULT true)
RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$
DECLARE
  v_e        public.run_entries%ROWTYPE;
  v_curve    numeric[];
  v_row      record;
  v_hitprod  numeric := 1;      -- odds product of legs already won
  v_miss     integer := 0;      -- legs already lost
  v_odds     numeric[] := '{}'; -- unresolved: picked odds
  v_pr       numeric[] := '{}'; -- unresolved: de-vigged probability of the pick
  v_n        integer;
  v_mask     integer;
  v_i        integer;
  v_prob     numeric;
  v_w        numeric;
  v_m        integer;
  v_sum      numeric := 0;
  v_or       numeric;
BEGIN
  SELECT * INTO v_e FROM public.run_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_curve := public.run_decay_curve(v_e.decay, v_e.decay_curve);

  FOR v_row IN
    SELECT pk.pick, pk.odds, l.result, l.odds_w, l.odds_d, l.odds_l
      FROM public.run_entry_picks pk
      JOIN public.run_entries e ON e.id = pk.entry_id
      JOIN public.run_legs l    ON l.run_id = e.run_id AND l.leg_index = pk.leg_index
     WHERE pk.entry_id = p_entry_id
  LOOP
    IF v_row.result IS NOT NULL THEN
      IF v_row.result = v_row.pick THEN
        v_hitprod := v_hitprod * v_row.odds;
      ELSE
        v_miss := v_miss + 1;
      END IF;
    ELSIF NOT p_settled_only THEN
      v_or   := (1.0/v_row.odds_w) + (1.0/v_row.odds_d) + (1.0/v_row.odds_l);
      v_odds := array_append(v_odds, v_row.odds);
      v_pr   := array_append(v_pr, (1.0 / v_row.odds) / v_or);
    END IF;
  END LOOP;

  v_n := COALESCE(array_length(v_odds, 1), 0);

  -- Settlement basis, or nothing left to be uncertain about.
  IF v_n = 0 THEN
    RETURN v_e.coefficient * v_hitprod * public.run_curve_at(v_curve, v_miss);
  END IF;

  FOR v_mask IN 0 .. ((1 << v_n) - 1) LOOP
    v_prob := 1; v_w := v_hitprod; v_m := v_miss;
    FOR v_i IN 1..v_n LOOP
      IF ((v_mask >> (v_i - 1)) & 1) = 1 THEN
        v_prob := v_prob * v_pr[v_i];
        v_w    := v_w * v_odds[v_i];
      ELSE
        v_prob := v_prob * (1 - v_pr[v_i]);
        v_m    := v_m + 1;
      END IF;
    END LOOP;
    v_sum := v_sum + v_prob * v_w * public.run_curve_at(v_curve, v_m);
  END LOOP;

  RETURN v_e.coefficient * v_sum;
END;
$$;
