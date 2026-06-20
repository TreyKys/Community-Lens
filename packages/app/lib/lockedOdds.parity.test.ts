/**
 * lib/lockedOdds.parity.test.ts
 *
 * EXACT-equality parity between the TypeScript algorithm
 * (lib/lockedOdds.ts) and the PL/pgSQL twin
 * (supabase/migrations/20260620180000_calculate_locked_odds_sql.sql).
 *
 * Display uses the TS function (in the modal). Server-side bet
 * placement / settlement uses the SQL function (inside the
 * place_bet_locked RPC). If the two ever drift, the user can be
 * quoted one number and paid another — exactly the discretionary-
 * payout trap we explicitly rejected. This test runs a sweep of
 * realistic inputs through both implementations and asserts identical
 * outputs on the user-facing financial fields (locked_odds, vig,
 * floor_payout, upper_payout, tier).
 *
 * GATING. This is an integration test — it needs a real Postgres
 * with the migration applied. We skip if SUPABASE env vars aren't
 * set so the suite stays green in CI / fresh checkouts. Run it
 * locally with the production env vars to confirm the SQL function
 * is in sync after any change to the algorithm.
 */

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  calculateLockedOdds,
  type MarketSnapshot,
  type UserContext,
  type ReserveContext,
} from './lockedOdds';

// Skip the entire suite if we don't have a Supabase to talk to. The
// SQL function is exercised by the place_bet_locked integration test
// in a Postgres testcontainer (Phase 3b); this file is the "is the
// production DB in sync?" check.
//
// NOTE: we explicitly check for placeholder values (e.g. the dummy
// `https://x.supabase.co` we set during CI builds) because they pass
// the truthy check but would 404 on every RPC. Treat them as absent.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHOULD_RUN = !!(
  SUPABASE_URL &&
  SUPABASE_SERVICE_ROLE_KEY &&
  SUPABASE_URL !== 'https://x.supabase.co' &&
  SUPABASE_SERVICE_ROLE_KEY !== 'x'
);

// ─── Fixtures ────────────────────────────────────────────────────────

interface ScenarioInput {
  name: string;
  market: MarketSnapshot;
  stake: number;
  outcomeIndex: number;
  user: UserContext;
  reserve: ReserveContext;
}

const HEALTHY: ReserveContext = { deployableTngn: 120_000, floorTngn: 30_000 };
const STRESSED: ReserveContext = { deployableTngn: 10_000, floorTngn: 30_000 };

const SCENARIOS: ScenarioInput[] = [
  // Day-1 markets across categories
  ...['sports', 'sports_top', 'politics', 'economy', 'entertainment', 'culture', 'crypto'].flatMap((category) => [
    {
      name: `day-1 ${category}, stake ₦200 outcome 0`,
      market: { category, seedPool: [8_000, 7_000], realPool: [0, 0] },
      stake: 200, outcomeIndex: 0, user: {}, reserve: HEALTHY,
    },
    {
      name: `day-1 ${category}, stake ₦500 outcome 1 (underdog)`,
      market: { category, seedPool: [8_000, 7_000], realPool: [0, 0] },
      stake: 500, outcomeIndex: 1, user: {}, reserve: HEALTHY,
    },
  ]),

  // Matured markets — varying flow
  {
    name: 'matured balanced market, stake ₦1k underdog',
    market: { category: 'sports', seedPool: [8_000, 7_000], realPool: [40_000, 25_000] },
    stake: 1_000, outcomeIndex: 1, user: {}, reserve: HEALTHY,
  },
  {
    name: 'heavy favorite, stake ₦500 on favorite (floor binds Tier 2)',
    market: { category: 'sports', seedPool: [10_000, 5_000], realPool: [100_000, 20_000] },
    stake: 500, outcomeIndex: 0, user: {}, reserve: HEALTHY,
  },
  {
    name: 'heavy favorite, stake ₦5k on underdog (long price)',
    market: { category: 'sports', seedPool: [10_000, 5_000], realPool: [100_000, 20_000] },
    stake: 5_000, outcomeIndex: 1, user: {}, reserve: HEALTHY,
  },

  // Boundary stakes
  { name: 'tier boundary 499', market: { category: 'sports', seedPool: [6_000, 6_000], realPool: [20_000, 20_000] }, stake: 499, outcomeIndex: 0, user: {}, reserve: HEALTHY },
  { name: 'tier boundary 500', market: { category: 'sports', seedPool: [6_000, 6_000], realPool: [20_000, 20_000] }, stake: 500, outcomeIndex: 0, user: {}, reserve: HEALTHY },

  // Whale slippage on thin market
  {
    name: 'whale on thin entertainment market',
    market: { category: 'entertainment', seedPool: [5_000, 5_000], realPool: [0, 0] },
    stake: 5_000, outcomeIndex: 0, user: {}, reserve: HEALTHY,
  },

  // Stressed reserve — vig widens
  {
    name: 'stressed reserve, ₦1k on balanced market',
    market: { category: 'sports', seedPool: [8_000, 8_000], realPool: [20_000, 20_000] },
    stake: 1_000, outcomeIndex: 1, user: {}, reserve: STRESSED,
  },

  // Pro user discount
  {
    name: 'pro forecaster on balanced market',
    market: { category: 'sports', seedPool: [8_000, 8_000], realPool: [20_000, 20_000] },
    stake: 1_000, outcomeIndex: 1, user: { accuracyTier: 'pro' }, reserve: HEALTHY,
  },

  // Vig override
  {
    name: 'per-market vig override (9%)',
    market: { category: 'sports', seedPool: [6_000, 6_000], realPool: [20_000, 20_000], vigPctOverride: 0.09 },
    stake: 500, outcomeIndex: 0, user: {}, reserve: HEALTHY,
  },

  // 3-outcome market — Home/Draw/Away
  {
    name: '3-way market, stake on Draw',
    market: { category: 'sports', seedPool: [5_000, 3_000, 4_000], realPool: [15_000, 8_000, 10_000] },
    stake: 750, outcomeIndex: 1, user: {}, reserve: HEALTHY,
  },
  {
    name: '3-way market, stake on Home (favorite)',
    market: { category: 'sports', seedPool: [5_000, 3_000, 4_000], realPool: [15_000, 8_000, 10_000] },
    stake: 750, outcomeIndex: 0, user: {}, reserve: HEALTHY,
  },
];

// ─── The parity check ────────────────────────────────────────────────

// We register the describe block conditionally rather than via
// describe.skip, because describe.skip still EVALUATES its callback
// to discover the suite shape, and creating a Supabase client with
// `undefined!` credentials throws at module load.
if (SHOULD_RUN) {
  describe('TypeScript ↔ PL/pgSQL parity (lockedOdds)', () => {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    SCENARIOS.forEach((s) => {
      it(`matches on: ${s.name}`, async () => {
        const ts = calculateLockedOdds(s.market, s.stake, s.outcomeIndex, s.user, s.reserve);

        const { data, error } = await supabase
          .rpc('calculate_locked_odds_sql', {
            p_seed_pool: s.market.seedPool,
            p_real_pool: s.market.realPool,
            p_category: s.market.category,
            p_vig_override: s.market.vigPctOverride ?? null,
            p_stake: s.stake,
            p_outcome_index: s.outcomeIndex,
            p_accuracy_tier: s.user.accuracyTier ?? null,
            p_deployable_tngn: s.reserve.deployableTngn,
            p_floor_tngn: s.reserve.floorTngn,
          })
          .single<{
            locked_odds: number;
            vig_applied: number;
            tier: number;
            net_stake: number;
            floor_payout: number;
            upper_payout: number;
          }>();

        if (error) throw error;
        expect(data).not.toBeNull();

        // The user-facing financial outputs must be EXACTLY equal —
        // these are the numbers the modal displays and the bet row
        // stores. Drift here is a regression we must catch loudly.
        expect(Number(data!.locked_odds)).toBe(ts.lockedOdds);
        expect(Number(data!.tier)).toBe(ts.tier);
        expect(Number(data!.floor_payout)).toBe(ts.floorPayout);
        expect(Number(data!.upper_payout)).toBe(ts.upperPayout);

        // Vig and net_stake are floating point intermediates. Allow a
        // tiny epsilon for numeric-vs-double rounding. The rounded
        // locked_odds and integer floor_payout are the contract.
        expect(Number(data!.vig_applied)).toBeCloseTo(ts.vigApplied, 6);
        expect(Number(data!.net_stake)).toBeCloseTo(ts.netStake, 4);
      });
    });
  });
} else {
  // Placeholder so the test file isn't reported as empty.
  describe('TypeScript ↔ PL/pgSQL parity (lockedOdds) — skipped', () => {
    it('skipped because SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars are not set', () => {
      expect(true).toBe(true);
    });
  });
}
