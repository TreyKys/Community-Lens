-- Phase 7: Multiplier slips + legs + Boosts consumable economy.
--
-- Additive. Defaults off. No existing behaviour changes. Multiplier
-- placement only happens through the new place_multiplier_slip RPC
-- (next migration); these tables just hold the data.
--
-- See docs/locked-odds-and-multipliers-spec.md § 9 and § 10.

-- ── multiplier_slips ────────────────────────────────────────────────
-- One row per placed parlay. A slip is house-vs-user: the stake never
-- enters any market pool. combined_odds is the product of the legs'
-- locked floor odds, frozen at placement (Sportybet-style fixed odds).
CREATE TABLE IF NOT EXISTS public.multiplier_slips (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slip_stake_tngn          numeric NOT NULL CHECK (slip_stake_tngn >= 100),
  net_slip_stake_tngn      numeric NOT NULL CHECK (net_slip_stake_tngn > 0),
  entry_rake_tngn          numeric NOT NULL DEFAULT 0,
  combined_odds            numeric NOT NULL CHECK (combined_odds >= 1),
  effective_combined_odds  numeric NOT NULL CHECK (effective_combined_odds >= 1),
  payout_tngn              numeric NOT NULL CHECK (payout_tngn >= 0),
  tier                     smallint NOT NULL CHECK (tier IN (1, 2)),
  legs_total               smallint NOT NULL CHECK (legs_total >= 2),
  legs_resolved            smallint NOT NULL DEFAULT 0,
  legs_won                 smallint NOT NULL DEFAULT 0,
  -- active = still live; won = all legs won (paid); lost = a leg lost;
  -- voided = whole slip refunded (e.g. all legs voided).
  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'won', 'lost', 'voided')),
  final_payout_tngn        numeric,            -- filled at settlement
  created_at               timestamptz NOT NULL DEFAULT now(),
  settled_at               timestamptz
);

CREATE INDEX IF NOT EXISTS multiplier_slips_user_idx
  ON public.multiplier_slips(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS multiplier_slips_status_idx
  ON public.multiplier_slips(status) WHERE status = 'active';

COMMENT ON TABLE public.multiplier_slips IS
  'Parlay slips (Phase 7). House-vs-user: the stake never enters a market pool. combined_odds = product of leg floor odds, frozen at placement. Settles by trickle as each leg''s market resolves; one losing leg kills the slip.';

ALTER TABLE public.multiplier_slips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS multiplier_slips_owner_read ON public.multiplier_slips;
CREATE POLICY multiplier_slips_owner_read ON public.multiplier_slips
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS multiplier_slips_service_all ON public.multiplier_slips;
CREATE POLICY multiplier_slips_service_all ON public.multiplier_slips
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── multiplier_legs ─────────────────────────────────────────────────
-- One row per leg. Locked floor odds + vig frozen at placement.
-- realized_odds is filled when the leg's market resolves (= locked_odds
-- for a win, 1.0 for a void). A lost leg kills the parent slip.
CREATE TABLE IF NOT EXISTS public.multiplier_legs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_id           uuid NOT NULL REFERENCES public.multiplier_slips(id) ON DELETE CASCADE,
  market_id         bigint NOT NULL REFERENCES public.markets(id),
  outcome_index     integer NOT NULL CHECK (outcome_index >= 0),
  locked_odds       numeric NOT NULL CHECK (locked_odds >= 1.20 AND locked_odds <= 25),
  vig_at_stake_pct  numeric NOT NULL CHECK (vig_at_stake_pct >= 0.04 AND vig_at_stake_pct <= 0.15),
  realized_odds     numeric,
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'won', 'lost', 'void')),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The settlement query "find all active legs on market X" is the hot
-- path during resolution — index it.
CREATE INDEX IF NOT EXISTS multiplier_legs_market_active_idx
  ON public.multiplier_legs(market_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS multiplier_legs_slip_idx
  ON public.multiplier_legs(slip_id);
-- One leg per (slip, market) — DB-level guard for the one-leg-per-event
-- rule, defence in depth behind the validateSlip check.
CREATE UNIQUE INDEX IF NOT EXISTS multiplier_legs_unique_slip_market
  ON public.multiplier_legs(slip_id, market_id);

COMMENT ON TABLE public.multiplier_legs IS
  'Individual legs of a Multiplier slip. locked_odds is the leg''s floor multiplier frozen at placement. realized_odds set at settlement (= locked_odds on win, 1.0 on void). Unique on (slip_id, market_id) enforces one leg per event.';

ALTER TABLE public.multiplier_legs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS multiplier_legs_owner_read ON public.multiplier_legs;
CREATE POLICY multiplier_legs_owner_read ON public.multiplier_legs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.multiplier_slips s WHERE s.id = slip_id AND s.user_id = auth.uid())
  );
DROP POLICY IF EXISTS multiplier_legs_service_all ON public.multiplier_legs;
CREATE POLICY multiplier_legs_service_all ON public.multiplier_legs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── boost_wallet ────────────────────────────────────────────────────
-- The consumable that unlocks placing a Multiplier slip. One row per
-- user. balance is current spendable Boosts. Each slip placement spends
-- one. Free grant on first need, daily recharge up to a cap, purchase
-- (Phase 8 payment flow) tops up beyond.
CREATE TABLE IF NOT EXISTS public.boost_wallet (
  user_id            uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance            integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_granted   integer NOT NULL DEFAULT 0,
  lifetime_spent     integer NOT NULL DEFAULT 0,
  last_recharge_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.boost_wallet IS
  'Per-user Boosts balance — the consumable that unlocks placing a Multiplier slip. Free signup grant + daily recharge up to a cap + purchasable (Phase 8). One Boost spent per slip placed.';

ALTER TABLE public.boost_wallet ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS boost_wallet_owner_read ON public.boost_wallet;
CREATE POLICY boost_wallet_owner_read ON public.boost_wallet
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS boost_wallet_service_all ON public.boost_wallet;
CREATE POLICY boost_wallet_service_all ON public.boost_wallet
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── boost_ledger ────────────────────────────────────────────────────
-- Audit trail for every Boost movement (grant / recharge / spend /
-- purchase / refund). Keeps boost_wallet.balance reconstructable.
CREATE TABLE IF NOT EXISTS public.boost_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delta       integer NOT NULL,        -- +grant/+recharge/+purchase/+refund, -spend
  reason      text NOT NULL CHECK (reason IN ('signup_grant', 'daily_recharge', 'slip_spend', 'purchase', 'slip_refund', 'admin_adjust')),
  slip_id     uuid REFERENCES public.multiplier_slips(id) ON DELETE SET NULL,
  balance_after integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS boost_ledger_user_idx
  ON public.boost_ledger(user_id, created_at DESC);

ALTER TABLE public.boost_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS boost_ledger_owner_read ON public.boost_ledger;
CREATE POLICY boost_ledger_owner_read ON public.boost_ledger
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS boost_ledger_service_all ON public.boost_ledger;
CREATE POLICY boost_ledger_service_all ON public.boost_ledger
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

NOTIFY pgrst, 'reload schema';
