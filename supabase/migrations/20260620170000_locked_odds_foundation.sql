-- Phase 1 of the locked-odds engine: the foundation.
--
-- This migration is purely ADDITIVE. It adds columns and tables that the
-- locked-odds engine and Multiplier slips will read/write in later phases.
-- Crucially, it does NOT change any existing behaviour: no RPCs are modified,
-- no policies are tightened on existing tables, and every new column has a
-- safe default that preserves the current parimutuel settlement path.
--
-- Safe to apply on a live system. Safe to roll back: every change is additive
-- and can be undone with DROP COLUMN / DROP TABLE without touching any
-- existing row.
--
-- See docs/locked-odds-and-multipliers-spec.md for the canonical design.

-- ── 1. markets: per-market locked-odds config ───────────────────────────────
--
-- All defaults preserve current behaviour. is_locked_odds=false means existing
-- markets continue to settle via parimutuel until an admin explicitly opts a
-- market in.
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS is_locked_odds boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seed_pool jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS seed_probability numeric
    CHECK (seed_probability IS NULL OR (seed_probability > 0 AND seed_probability < 1)),
  ADD COLUMN IF NOT EXISTS vig_pct numeric NOT NULL DEFAULT 0.08
    CHECK (vig_pct >= 0.04 AND vig_pct <= 0.15),
  ADD COLUMN IF NOT EXISTS is_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.markets.is_locked_odds IS
  'Rollout flag. When true, stakes route through the locked-odds engine; when false the existing parimutuel path is used. Defaults to false so every existing market continues to settle exactly as it did before this migration.';
COMMENT ON COLUMN public.markets.seed_pool IS
  'House-funded starting pool, keyed by outcome_index::text. The sum of seed + crowd stakes forms the effective pool used to derive locked odds. The seed is recovered by the house at settlement (never paid out to users).';
COMMENT ON COLUMN public.markets.seed_probability IS
  'Admin''s pre-seed estimate of the most likely outcome (0..1). Stored for post-resolution calibration audit ("was our estimate honest?"). NOT load-bearing in the odds math, which derives everything from the actual seed_pool split.';
COMMENT ON COLUMN public.markets.vig_pct IS
  'Base vig for this market. Per-category defaults are applied at creation time; admin can override. The actual vig applied at stake placement may be HIGHER due to dynamic surcharges (thin pool, large stake, reserve stress). See lib/lockedOdds.ts.';
COMMENT ON COLUMN public.markets.is_paused IS
  'Admin pause for locked-odds markets. New locked stakes silently route to parimutuel fallback; existing locked bets are honoured exactly as placed.';


-- ── 2. user_bets: freeze locked odds + tier on each bet row ─────────────────
--
-- Nullable on existing rows. Legacy parimutuel bets have locked_odds = NULL
-- and continue to be settled via the original payout-from-pool path. New
-- locked-odds bets fill all three fields.
ALTER TABLE public.user_bets
  ADD COLUMN IF NOT EXISTS locked_odds numeric
    CHECK (locked_odds IS NULL OR (locked_odds >= 1.02 AND locked_odds <= 25)),
  ADD COLUMN IF NOT EXISTS vig_at_stake_pct numeric
    CHECK (vig_at_stake_pct IS NULL OR (vig_at_stake_pct >= 0.04 AND vig_at_stake_pct <= 0.15)),
  ADD COLUMN IF NOT EXISTS tier smallint
    CHECK (tier IS NULL OR tier IN (1, 2)),
  ADD COLUMN IF NOT EXISTS bet_kind text NOT NULL DEFAULT 'single'
    CHECK (bet_kind IN ('single', 'multiplier_leg'));

COMMENT ON COLUMN public.user_bets.locked_odds IS
  'Frozen floor multiplier from the exact moment the bet was placed. The user is guaranteed AT LEAST (net_stake * locked_odds) at settlement. NULL for legacy parimutuel bets — their payout is still derived from the final pool composition at resolution.';
COMMENT ON COLUMN public.user_bets.vig_at_stake_pct IS
  'The dynamic vig that was applied when computing locked_odds. Stored so settlement can compute the parimutuel-with-vig upside path using the SAME vig the user was originally quoted, even though reserve health / market state may have changed between stake and resolution. Without this, the floor-up promise (pay MAX of floor and pool-implied) cannot be honoured deterministically.';
COMMENT ON COLUMN public.user_bets.tier IS
  '1 = Community (stake < 500), 2 = Pro (stake >= 500). For multiplier_leg rows, derived from the SLIP stake, not the per-leg notional, so a 5-leg slip at 400 is five Tier-1 legs.';
COMMENT ON COLUMN public.user_bets.bet_kind IS
  'single = a standalone bet; multiplier_leg = one leg of a Multiplier slip (see Phase 7). Defaults to single so every existing bet keeps its semantics.';


-- ── 3. house_reserve: the 150k singleton ────────────────────────────────────
--
-- One row per universe. The CHECK (id = 1) plus PK guarantees that. We seed
-- it with the full 150k at the floor split decided in the spec. The reserve
-- mutates only via SECURITY DEFINER RPCs in later phases (not yet built).
CREATE TABLE IF NOT EXISTS public.house_reserve (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_tngn numeric NOT NULL DEFAULT 150000 CHECK (total_tngn >= 0),
  floor_tngn numeric NOT NULL DEFAULT 30000 CHECK (floor_tngn >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.house_reserve (id, total_tngn, floor_tngn) VALUES (1, 150000, 30000)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.house_reserve IS
  'Singleton (id always 1). Tracks the house capital pool that backs locked-odds payouts. deployable = total - floor. The floor is the untouchable safety buffer; when deployable approaches it the engine pauses Tier 2 and silently routes stakes to parimutuel.';

-- Service-role only. No user or even regular admin can read or write the
-- reserve directly — all access goes through RPCs that audit each move.
ALTER TABLE public.house_reserve ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS house_reserve_service_only ON public.house_reserve;
CREATE POLICY house_reserve_service_only ON public.house_reserve
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');


-- ── 4. market_liability: per-market exposure ledger ─────────────────────────
--
-- Updated atomically alongside every locked-odds bet placement and
-- resolution. Used by:
--   • the stake validator (enforce per-market liability ceiling),
--   • the admin dashboard (live exposure monitoring),
--   • the auto-pause logic (aggregate against reserve health).
CREATE TABLE IF NOT EXISTS public.market_liability (
  market_id bigint PRIMARY KEY REFERENCES public.markets(id) ON DELETE CASCADE,
  exposure_by_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  worst_case_tngn numeric NOT NULL DEFAULT 0 CHECK (worst_case_tngn >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.market_liability IS
  'One row per locked-odds market. exposure_by_outcome[i] = SUM(net_stake * locked_odds) of all bets on outcome i (what the house owes if i wins). worst_case_tngn = MAX across outcomes — the single number that gates the per-market liability ceiling check.';

ALTER TABLE public.market_liability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_liability_service_only ON public.market_liability;
CREATE POLICY market_liability_service_only ON public.market_liability
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');


-- ── 5. tier_routing_log: audit trail for routing decisions ──────────────────
--
-- Every stake on a locked-odds market gets one row: which tier was REQUESTED
-- (by stake size) and which actually RAN (after reserve-health and liability
-- ceiling checks). Lets us answer "why did this Tier 2 bet fall back to
-- parimutuel?" weeks later, when reproduction is impossible.
CREATE TABLE IF NOT EXISTS public.tier_routing_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  market_id bigint REFERENCES public.markets(id) ON DELETE SET NULL,
  requested_stake numeric NOT NULL,
  intended_tier smallint NOT NULL CHECK (intended_tier IN (1, 2)),
  actual_tier smallint NOT NULL CHECK (actual_tier IN (1, 2)),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes match the two query shapes we'll actually run: "what happened on
-- market X" (admin forensic), and "every routing decision for user Y" (user
-- support / dispute).
CREATE INDEX IF NOT EXISTS tier_routing_log_market_idx
  ON public.tier_routing_log(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tier_routing_log_user_idx
  ON public.tier_routing_log(user_id, created_at DESC);

COMMENT ON TABLE public.tier_routing_log IS
  'Audit trail. Every stake placement on a locked-odds market logs which tier was requested (by stake size) and which actually ran (after reserve-health / liability-ceiling checks). Includes a free-form reason so we can audit the decision later.';

ALTER TABLE public.tier_routing_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tier_routing_log_service_only ON public.tier_routing_log;
CREATE POLICY tier_routing_log_service_only ON public.tier_routing_log
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');


-- ── 6. reserve_health view: read-only convenience ──────────────────────────
--
-- The odds engine and admin dashboard both need to know "how much deployable
-- capital is left and how close are we to the floor?". Computing it from
-- house_reserve in every caller invites drift; one view keeps the formula in
-- one place. The view inherits the underlying table's RLS, so the same
-- service-role gate applies.
CREATE OR REPLACE VIEW public.reserve_health AS
SELECT
  total_tngn,
  floor_tngn,
  GREATEST(0, total_tngn - floor_tngn) AS deployable_tngn,
  CASE WHEN floor_tngn > 0
       THEN GREATEST(0, total_tngn - floor_tngn) / floor_tngn
       ELSE 0
  END AS health_ratio,
  updated_at
FROM public.house_reserve
WHERE id = 1;

COMMENT ON VIEW public.reserve_health IS
  'health_ratio = deployable / floor. 0 = at the safety floor (Tier 2 paused). 1 = one floor''s worth above the floor. The dynamic stake cap and vig stress surcharge both key off this number.';
