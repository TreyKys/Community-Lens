-- ============================================================================
-- Open Markets — schema (phase 2 of the LMSR engine)
-- ============================================================================
-- A third market engine alongside parimutuel and locked-odds. Shares pay ₦1 if
-- the outcome occurs and ₦0 if not, and can be sold before resolution — which
-- is what makes markets with no known resolution date viable at all.
--
-- Nothing here touches the existing engines. New tables, new functions.
--
-- ── The three shapes that caused this platform's prior incidents ────────────
-- Every past money incident came from the same root: a money movement whose
-- "did this already happen?" question had no definitive, single-transaction
-- answer.
--   * deposits      -> fixed with a ledger row (treasury_movements)
--   * bet settling  -> fixed with a locked status CAS
--   * bonus split   -> broke because a CONSERVED quantity (funding source) was
--                      stored as a DERIVED SCALAR a migration could zero
--
-- This schema answers all three up front:
--   1. open_trades.client_trade_id  UNIQUE  -> trades are idempotent
--   2. open_settlements (position_id, kind) UNIQUE -> every payout claimed once
--   3. share LOTS (shares_cash / shares_bonus) instead of a bonus_frac scalar
--      -> funding source is additively conserved across buys, sells, rolls,
--         voids and settlement, and cannot be silently overwritten
-- ============================================================================

-- ── Markets ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.open_markets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question          text NOT NULL,
  description       text,
  category          text NOT NULL,
  outcomes          text[] NOT NULL,
  -- Declared BEFORE opening and immutable after. The market cannot be resolved
  -- against a source chosen after the fact.
  resolution_source text NOT NULL,
  resolution_detail text,
  resolution_timezone text NOT NULL DEFAULT 'Africa/Lagos',
  -- Which print counts for a statistic that gets revised. Unset = disputes.
  revision_policy   text NOT NULL DEFAULT 'first_print'
                      CHECK (revision_policy IN ('first_print', 'as_of_date')),
  -- What happens if the source never answers.
  unresolvable_policy text NOT NULL DEFAULT 'void_at_last_price'
                      CHECK (unresolvable_policy IN ('void_at_last_price', 'roll_to_next_horizon')),

  -- LMSR state. b is IMMUTABLE once open: changing it reprices every existing
  -- position discontinuously (a ₦3,296 silent transfer on a mid-size book) and
  -- silently re-bases the exposure budget. Liquidity changes need a halt and
  -- an unwind, not a live edit.
  b                 numeric NOT NULL CHECK (b > 0),
  q                 numeric[] NOT NULL,
  q_initial         numeric[] NOT NULL,

  status            text NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review','revise','rejected','open',
                                        'halted','horizon_window','pending_payout',
                                        'resolved','voided','retired')),
  horizon_at        timestamptz,
  horizon_count     smallint NOT NULL DEFAULT 0,
  -- Trading stops here, before the outcome becomes public. Without it the book
  -- is live while an admin is literally looking at the answer.
  trading_closes_at timestamptz,

  resolved_outcome  smallint,
  resolved_by       uuid REFERENCES public.users(id),
  resolution_confirmed_by uuid REFERENCES public.users(id),
  resolution_evidence_url text,
  -- Payouts are released only after the dispute window closes. Clawing money
  -- back from a spent wallet is only partially possible (see the `shortfall`
  -- column on reclaim_slip_bonus_split) so we never rely on it.
  dispute_window_hours smallint NOT NULL DEFAULT 24,
  settlement_locked_until timestamptz,

  void_kind         text CHECK (void_kind IN ('operational','house_fault')),
  halted_by         uuid REFERENCES public.users(id),
  halted_reason     text,
  halted_at         timestamptz,

  created_by        uuid REFERENCES public.users(id),
  bond_tngn         numeric NOT NULL DEFAULT 0,
  bond_bonus_tngn   numeric NOT NULL DEFAULT 0,   -- refund each to its source
  bond_status       text NOT NULL DEFAULT 'none'
                      CHECK (bond_status IN ('none','held','returned','forfeited')),

  -- Creator economics. threshold_tngn is SNAPSHOT at approval and never
  -- recomputed from b: recomputing from a mutable b would let an admin lower
  -- the bar retroactively and unlock payouts that were never earned.
  threshold_tngn    numeric NOT NULL DEFAULT 0,
  fees_collected    numeric NOT NULL DEFAULT 0,
  fees_collected_real numeric NOT NULL DEFAULT 0,  -- excludes bonus-funded flow
  creator_accrued   numeric NOT NULL DEFAULT 0,
  creator_paid      numeric NOT NULL DEFAULT 0,

  review_score      smallint,
  review_notes      text,
  reviewed_by       uuid REFERENCES public.users(id),

  created_at        timestamptz NOT NULL DEFAULT now(),
  opened_at         timestamptz,
  resolved_at       timestamptz,

  CONSTRAINT open_markets_outcomes_min   CHECK (array_length(outcomes, 1) >= 2),
  CONSTRAINT open_markets_q_matches      CHECK (array_length(q, 1) = array_length(outcomes, 1)),
  CONSTRAINT open_markets_q_init_matches CHECK (array_length(q_initial, 1) = array_length(outcomes, 1)),
  -- Creator can never be paid more than accrued.
  CONSTRAINT open_markets_creator_paid   CHECK (creator_paid <= creator_accrued),
  CONSTRAINT open_markets_fees_nonneg    CHECK (fees_collected >= 0 AND fees_collected_real >= 0)
);

CREATE INDEX IF NOT EXISTS open_markets_status_idx   ON public.open_markets (status, horizon_at);
CREATE INDEX IF NOT EXISTS open_markets_creator_idx  ON public.open_markets (created_by);

-- ── Positions: share LOTS, never a proportion ──────────────────────────────
-- bonus_frac as a single mutable scalar is the exact shape that failed before:
-- buy ₦50,000 with bonus then ₦100 with cash, and a last-write-wins update
-- stamps the whole position to 0% bonus, so it settles 100% to withdrawable
-- cash. Lots are conserved additively and cannot be overwritten.
CREATE TABLE IF NOT EXISTS public.open_positions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id     uuid NOT NULL REFERENCES public.open_markets(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  outcome_idx   smallint NOT NULL,

  shares_cash   numeric NOT NULL DEFAULT 0 CHECK (shares_cash  >= 0),
  shares_bonus  numeric NOT NULL DEFAULT 0 CHECK (shares_bonus >= 0),
  cost_cash     numeric NOT NULL DEFAULT 0,
  cost_bonus    numeric NOT NULL DEFAULT 0,

  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','settled','refunded','cashed_out')),
  settled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (market_id, user_id, outcome_idx)
);

CREATE INDEX IF NOT EXISTS open_positions_user_idx   ON public.open_positions (user_id);
CREATE INDEX IF NOT EXISTS open_positions_market_idx ON public.open_positions (market_id, status);

-- ── Trades: immutable log AND the idempotency anchor ───────────────────────
-- A row lock stops interleaving; it does nothing about REPETITION. The deposit
-- fix needed both a lock and a ledger anchor, and so does this: a transaction
-- that commits but whose HTTP response is lost gets retried, and without a
-- unique client key the retry is a brand-new valid second trade at a new price.
CREATE TABLE IF NOT EXISTS public.open_trades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_trade_id uuid NOT NULL,
  market_id       uuid NOT NULL REFERENCES public.open_markets(id),
  user_id         uuid NOT NULL REFERENCES public.users(id),
  outcome_idx     smallint NOT NULL,
  delta_shares    numeric NOT NULL,
  cost_tngn       numeric NOT NULL,      -- signed, pre-fee
  fee_tngn        numeric NOT NULL CHECK (fee_tngn >= 0),
  paid_cash       numeric NOT NULL DEFAULT 0,
  paid_bonus      numeric NOT NULL DEFAULT 0,
  price_after     numeric NOT NULL,
  q_after         numeric[] NOT NULL,    -- full state: the book is replayable
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS open_trades_client_id_uk ON public.open_trades (client_trade_id);
CREATE INDEX IF NOT EXISTS open_trades_market_idx ON public.open_trades (market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS open_trades_mkt_user_idx ON public.open_trades (market_id, user_id);

-- ── Settlements: the definitive "was this money moved?" record ─────────────
CREATE TABLE IF NOT EXISTS public.open_settlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES public.open_positions(id) ON DELETE CASCADE,
  market_id   uuid NOT NULL REFERENCES public.open_markets(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('resolve','void','cash_out','retire')),
  tngn        numeric NOT NULL DEFAULT 0,
  bonus       numeric NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- One payout per position per event. A retried sweep is a no-op, not a
  -- second payment.
  UNIQUE (position_id, kind)
);

-- ── Disputes ───────────────────────────────────────────────────────────────
-- A flag must cost something and must not, on its own, freeze everyone's money.
CREATE TABLE IF NOT EXISTS public.open_market_disputes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   uuid NOT NULL REFERENCES public.open_markets(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  stake_tngn  numeric NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','upheld','rejected','withdrawn')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  ruled_at    timestamptz,
  ruled_by    uuid REFERENCES public.users(id),
  ruling      text,
  UNIQUE (market_id, user_id)      -- one open dispute per user per market
);

-- ── RLS: readable by all, writable only by service_role ────────────────────
ALTER TABLE public.open_markets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_positions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_trades            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_settlements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_market_disputes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS open_markets_public_read ON public.open_markets;
CREATE POLICY open_markets_public_read ON public.open_markets
  FOR SELECT USING (status IN ('open','horizon_window','pending_payout','resolved','voided','retired','halted'));

DROP POLICY IF EXISTS open_positions_owner_read ON public.open_positions;
CREATE POLICY open_positions_owner_read ON public.open_positions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS open_trades_public_read ON public.open_trades;
CREATE POLICY open_trades_public_read ON public.open_trades FOR SELECT USING (true);

DROP POLICY IF EXISTS open_settlements_owner_read ON public.open_settlements;
CREATE POLICY open_settlements_owner_read ON public.open_settlements
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.open_positions p
     WHERE p.id = position_id AND p.user_id = auth.uid()));

DROP POLICY IF EXISTS open_disputes_owner_read ON public.open_market_disputes;
CREATE POLICY open_disputes_owner_read ON public.open_market_disputes
  FOR SELECT USING (auth.uid() = user_id);

-- Service role does everything else.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['open_markets','open_positions','open_trades',
                           'open_settlements','open_market_disputes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_service_all ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_service_all ON public.%I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
      t, t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
