-- TxLINE World Cup integration
--
-- Adds the columns that let an Opinions market (a) map to a TxLINE fixture,
-- (b) carry the live TxODDS consensus line, and (c) record a proof-backed,
-- transparently-overridable resolution. Everything here is additive and
-- nullable: existing markets and the existing settlement path are untouched
-- when txline_fixture_id IS NULL.
--
-- Governance rule encoded by these columns:
--   Default source of truth is the signed feed. Any departure is recorded,
--   attributed, timestamped, and shown publicly next to the feed's proposal.

-- 1. Market <-> TxLINE mapping + consensus + resolution provenance ----------
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS txline_fixture_id     bigint,
  ADD COLUMN IF NOT EXISTS txline_competition_id integer,
  -- Latest StablePrice consensus per option, e.g.
  --   { "updatedAt": 1782525600000,
  --     "options": [ { "label": "Paraguay", "decimal": 2.10 },
  --                  { "label": "Draw",     "decimal": 3.30 },
  --                  { "label": "Australia","decimal": 3.75 } ] }
  ADD COLUMN IF NOT EXISTS consensus_odds        jsonb,
  -- feed | admin_override | manual  (null until resolved)
  ADD COLUMN IF NOT EXISTS resolution_source     text,
  ADD COLUMN IF NOT EXISTS override_reason       text,
  ADD COLUMN IF NOT EXISTS resolved_by           text,
  -- The stat-validation payload + on-chain verification result + PDA/program
  -- ref that backs a feed resolution. Rendered on the public Proof panel.
  --   { "fixtureId": 17588229, "seq": 128, "statKeys": [1,2],
  --     "p1Goals": 2, "p2Goals": 1, "proposedOutcome": 0,
  --     "verified": true, "network": "devnet",
  --     "programId": "6pW6...", "dailyScoresPda": "...",
  --     "epochDay": 20631, "minTimestamp": 1782525600000,
  --     "proof": { ...raw stat-validation response... },
  --     "verifiedAt": 1782525900000 }
  ADD COLUMN IF NOT EXISTS txline_proof          jsonb;

-- Dedupe/lookup markets by their TxLINE fixture. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS markets_txline_fixture_id_idx
  ON public.markets (txline_fixture_id)
  WHERE txline_fixture_id IS NOT NULL;

COMMENT ON COLUMN public.markets.resolution_source IS
  'How the resolved_outcome was decided: feed = accepted the TxLINE signed '
  'proof as-is; admin_override = a human departed from the feed (see '
  'override_reason/resolved_by); manual = resolved outside the TxLINE path.';

-- 2. Live-state hot cache for the World Cup surface -------------------------
-- One row per covered fixture. Written by the scores ingestion, read by the
-- /worldcup live board. Kept separate from markets so the fast SSE-driven
-- writes never contend with market/pool rows.
CREATE TABLE IF NOT EXISTS public.txline_live_state (
  fixture_id   bigint PRIMARY KEY,
  market_id    bigint REFERENCES public.markets(id) ON DELETE SET NULL,
  competition  text,
  participant1 text,
  participant2 text,
  -- Soccer game-phase id: 1 NS, 2 H1, 3 HT, 4 H2, 5 F, 13 FPE (ended after
  -- penalties), 15 A (abandoned), 16 C (cancelled). See soccer feed docs.
  phase        integer,
  p1_goals     integer DEFAULT 0,
  p2_goals     integer DEFAULT 0,
  -- True once an action=game_finalised (statusId=100) record has been seen.
  is_final     boolean DEFAULT false,
  last_seq     bigint,
  last_event   jsonb,
  start_time   timestamptz,
  updated_at   timestamptz DEFAULT now()
);

ALTER TABLE public.txline_live_state ENABLE ROW LEVEL SECURITY;

-- Live scores are public information; anyone may read the board.
DROP POLICY IF EXISTS "txline_live_state public read" ON public.txline_live_state;
CREATE POLICY "txline_live_state public read"
  ON public.txline_live_state FOR SELECT USING (true);

-- Writes happen only through the service-role key in the ingestion routes,
-- which bypasses RLS, so no INSERT/UPDATE policy is granted to anon/auth.

CREATE INDEX IF NOT EXISTS txline_live_state_market_id_idx
  ON public.txline_live_state (market_id);
CREATE INDEX IF NOT EXISTS txline_live_state_updated_at_idx
  ON public.txline_live_state (updated_at DESC);
