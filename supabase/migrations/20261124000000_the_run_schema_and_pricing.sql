-- ============================================================================
-- The Run — five fixtures, one stake, value that accrues and waters down
-- ============================================================================
-- A Run is a card of 5 fixtures resolving over ~5 weeks. The player marks
-- W/D/L against each, pays ONE stake, and holds a live position: every leg
-- they call right multiplies it by that leg's odds, every leg they miss
-- shrinks it to `decay` of itself. They may cash out at any point.
--
-- PAYOUT
--   value_multiple = k · Π(odds of legs hit) · decay^(legs missed)
--
-- `k` is solved per ENTRY from that player's own picks so the house margin is
-- identical no matter what they select. Without it, backing longshots earned
-- ~7x what backing favourites did — measured, not theorised. k is frozen on
-- the entry at placement, exactly like locked odds on a bet.
--
--   p_i  = (1/o_i) / overround_i        -- de-vigged prob of the picked side
--   k    = rtp_target / Π_i [ p_i·o_i + (1-p_i)·decay ]
--
-- Deriving p from the leg's own three posted prices means the maths
-- self-calibrates to whatever margin the odds were set with, instead of
-- trusting a hardcoded vig constant.
--
-- CORRELATION — the expensive part
--   The model assumes legs are independent. A single-team card ("Chelsea's
--   next five") is NOT independent: form drives several results together, and
--   under strong correlation the house edge measured at -24%. That is why
--   `kind` exists and why single_team carries a much lower rtp_target. Prefer
--   erratic teams, whose form predicts little.
--
-- CONCENTRATION — the actually dangerous part
--   Everyone on a card plays the SAME five fixtures, so one set of results
--   pays every winner at once. A per-entry cap does nothing about this: 200
--   capped winners is still 200 winners. Simulated at 200 x N1,000 with 70% of
--   players herding onto favourites, the worst week lost N715,833. The same
--   book with an aggregate card cap lost N100,000, while the median week moved
--   by N159. Hence card_liability_cap_tngn, which is the single guardrail that
--   matters. Lowering rtp or tightening the per-entry cap barely touched it.
-- ============================================================================

-- ── The card ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                   text NOT NULL,
  kind                    text NOT NULL DEFAULT 'mixed'
                            CHECK (kind IN ('mixed','single_team')),
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','open','live','settled','void')),

  -- pricing
  rtp_target              numeric NOT NULL DEFAULT 0.90
                            CHECK (rtp_target > 0 AND rtp_target <= 1),
  decay                   numeric NOT NULL DEFAULT 0.80
                            CHECK (decay > 0 AND decay < 1),
  cashout_spread_pct      numeric NOT NULL DEFAULT 0.08
                            CHECK (cashout_spread_pct >= 0 AND cashout_spread_pct < 0.5),

  -- guardrails
  max_stake_tngn          numeric NOT NULL DEFAULT 2000  CHECK (max_stake_tngn > 0),
  min_stake_tngn          numeric NOT NULL DEFAULT 100   CHECK (min_stake_tngn > 0),
  payout_cap_multiple     numeric NOT NULL DEFAULT 25    CHECK (payout_cap_multiple > 1),
  payout_cap_tngn         numeric NOT NULL DEFAULT 50000 CHECK (payout_cap_tngn > 0),
  card_liability_cap_tngn numeric NOT NULL DEFAULT 300000 CHECK (card_liability_cap_tngn > 0),

  opens_at                timestamptz,
  closes_at               timestamptz NOT NULL,   -- entries shut here
  created_at              timestamptz NOT NULL DEFAULT now(),
  settled_at              timestamptz
);

-- ── The five fixtures ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.run_legs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  leg_index    smallint NOT NULL CHECK (leg_index BETWEEN 0 AND 4),
  fixture      text NOT NULL,
  kickoff_at   timestamptz,
  odds_w       numeric NOT NULL CHECK (odds_w > 1),
  odds_d       numeric NOT NULL CHECK (odds_d > 1),
  odds_l       numeric NOT NULL CHECK (odds_l > 1),
  result       text CHECK (result IN ('W','D','L')),
  resolved_at  timestamptz,
  UNIQUE (run_id, leg_index)
);

-- ── A player's entry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.run_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES public.runs(id),
  user_id          uuid NOT NULL REFERENCES public.users(id),
  stake_tngn       numeric NOT NULL CHECK (stake_tngn > 0),
  net_stake_tngn   numeric NOT NULL CHECK (net_stake_tngn > 0),
  -- frozen at placement so a later config change can never reprice a live bet
  coefficient      numeric NOT NULL CHECK (coefficient > 0),
  decay            numeric NOT NULL,
  payout_cap_tngn  numeric NOT NULL,
  status           text NOT NULL DEFAULT 'live'
                     CHECK (status IN ('live','cashed_out','settled','void')),
  cashed_out_tngn  numeric,
  cashed_out_at    timestamptz,
  payout_tngn      numeric,
  settled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_entries_run  ON public.run_entries(run_id, status);
CREATE INDEX IF NOT EXISTS idx_run_entries_user ON public.run_entries(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.run_entry_picks (
  entry_id   uuid NOT NULL REFERENCES public.run_entries(id) ON DELETE CASCADE,
  leg_index  smallint NOT NULL CHECK (leg_index BETWEEN 0 AND 4),
  pick       text NOT NULL CHECK (pick IN ('W','D','L')),
  odds       numeric NOT NULL CHECK (odds > 1),   -- frozen price of that cell
  PRIMARY KEY (entry_id, leg_index)
);

ALTER TABLE public.runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_legs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_entry_picks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read published runs" ON public.runs;
CREATE POLICY "Anyone can read published runs" ON public.runs
  FOR SELECT USING (status <> 'draft');
DROP POLICY IF EXISTS "Anyone can read legs" ON public.run_legs;
CREATE POLICY "Anyone can read legs" ON public.run_legs FOR SELECT USING (true);
DROP POLICY IF EXISTS "Players read own entries" ON public.run_entries;
CREATE POLICY "Players read own entries" ON public.run_entries
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Players read own picks" ON public.run_entry_picks;
CREATE POLICY "Players read own picks" ON public.run_entry_picks
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.run_entries e
                             WHERE e.id = entry_id AND e.user_id = auth.uid()));

-- ── Pricing: the per-entry coefficient ─────────────────────────────────────
-- p_odds: the odds of the side this player picked, per leg
-- p_overrounds: that leg's overround (1/o_w + 1/o_d + 1/o_l)
CREATE OR REPLACE FUNCTION public.run_coefficient(
  p_odds        numeric[],
  p_overrounds  numeric[],
  p_rtp_target  numeric,
  p_decay       numeric
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_factor numeric := 1;
  v_p      numeric;
  i        integer;
BEGIN
  IF array_length(p_odds,1) IS DISTINCT FROM array_length(p_overrounds,1) THEN
    RAISE EXCEPTION 'run_coefficient: odds/overround length mismatch';
  END IF;

  FOR i IN 1..array_length(p_odds,1) LOOP
    -- de-vigged probability of the picked side
    v_p := (1.0 / p_odds[i]) / p_overrounds[i];
    -- expected multiplier contribution of this leg: hit -> odds, miss -> decay
    v_factor := v_factor * ( v_p * p_odds[i] + (1 - v_p) * p_decay );
  END LOOP;

  IF v_factor <= 0 THEN
    RAISE EXCEPTION 'run_coefficient: non-positive factor';
  END IF;
  RETURN p_rtp_target / v_factor;
END;
$$;

-- ── Value of an entry ──────────────────────────────────────────────────────
-- settled_only = true  -> realised value from RESOLVED legs only (final payout)
-- settled_only = false -> expected value, carrying unresolved legs at their
--                         expected contribution (the cash-out basis)
CREATE OR REPLACE FUNCTION public.run_entry_value(
  p_entry_id     uuid,
  p_settled_only boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_e      public.run_entries%ROWTYPE;
  v_mult   numeric := 1;
  v_row    record;
  v_p      numeric;
  v_or     numeric;
BEGIN
  SELECT * INTO v_e FROM public.run_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR v_row IN
    SELECT pk.pick, pk.odds, l.result, l.odds_w, l.odds_d, l.odds_l
      FROM public.run_entry_picks pk
      JOIN public.run_entries e ON e.id = pk.entry_id
      JOIN public.run_legs l    ON l.run_id = e.run_id AND l.leg_index = pk.leg_index
     WHERE pk.entry_id = p_entry_id
  LOOP
    IF v_row.result IS NOT NULL THEN
      IF v_row.result = v_row.pick THEN
        v_mult := v_mult * v_row.odds;         -- hit: multiply by its odds
      ELSE
        v_mult := v_mult * v_e.decay;          -- miss: water down
      END IF;
    ELSIF NOT p_settled_only THEN
      -- unresolved: carry at expected contribution
      v_or := (1.0/v_row.odds_w) + (1.0/v_row.odds_d) + (1.0/v_row.odds_l);
      v_p  := (1.0 / v_row.odds) / v_or;
      v_mult := v_mult * ( v_p * v_row.odds + (1 - v_p) * v_e.decay );
    END IF;
    -- settled_only with an unresolved leg: contributes nothing yet (x1)
  END LOOP;

  RETURN v_e.coefficient * v_mult;
END;
$$;

COMMENT ON FUNCTION public.run_entry_value(uuid, boolean) IS
  'Value multiple of a Run entry. settled_only=true is the realised payout basis; false carries unresolved legs at expectation and is the cash-out basis (before spread).';

NOTIFY pgrst, 'reload schema';
