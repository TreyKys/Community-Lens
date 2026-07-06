import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Bounds for locked-odds seeding. Hardcoded conservative limits at
// launch — these line up with the Phase 0 spec's "max ₦14k seed per
// market" rule. Admin can override vig per market within the ALL-vig
// CHECK bounds (4%–15%) defined in the markets table.
const MIN_SEED_TNGN = 1_000;
const MAX_SEED_TNGN = 14_000;
const MIN_SEED_PROB = 0.05;
const MAX_SEED_PROB = 0.95;

/**
 * Build the per-outcome seed pool from a binary YES probability + a
 * total seed size. For multi-outcome markets we use a uniform split
 * unless a full seedPool array was supplied directly (Phase 7 will
 * add per-outcome inputs to the admin form).
 */
function buildSeedPool(
  totalSeedTngn: number,
  numOutcomes: number,
  binaryYesProb: number | null,
  explicitSeedPool: number[] | null,
): Record<string, number> {
  // Explicit array wins outright.
  if (explicitSeedPool && explicitSeedPool.length === numOutcomes) {
    const out: Record<string, number> = {};
    explicitSeedPool.forEach((v, i) => { out[String(i)] = Math.max(0, Math.round(Number(v) || 0)); });
    return out;
  }
  // Binary with explicit probability.
  if (numOutcomes === 2 && binaryYesProb !== null) {
    const yes = Math.round(totalSeedTngn * binaryYesProb);
    return { '0': yes, '1': totalSeedTngn - yes };
  }
  // Uniform fallback.
  const share = Math.round(totalSeedTngn / numOutcomes);
  const out: Record<string, number> = {};
  for (let i = 0; i < numOutcomes; i++) out[String(i)] = share;
  // Any rounding crumb goes to outcome 0 so the sum equals totalSeed exactly.
  out['0'] = totalSeedTngn - share * (numOutcomes - 1);
  return out;
}

export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      title, question, category, options, closesAt,
      parentMarketId, fixtureId, isJackpotEligible,
      sport, homeTeam, awayTeam, leagueCode, description,
      opensAt,           // optional — schedule the market to open later
      // Locked-odds config (all optional; absence keeps the legacy
      // parimutuel default of is_locked_odds = false).
      isLockedOdds,
      seedSizeTngn,
      seedProbability,   // binary YES probability, 0..1
      seedPool,          // optional explicit per-outcome array
      vigPct,            // optional per-market override
    } = body;

    if (!question || !category || !options || !closesAt) {
      return NextResponse.json({ error: 'Missing required fields: question, category, options, closesAt' }, { status: 400 });
    }

    if (!Array.isArray(options) || options.length < 2) {
      return NextResponse.json({ error: 'Options must be an array with at least 2 items' }, { status: 400 });
    }

    // Both engines are allowed. Locked-odds when the admin seeds it
    // (needs explicit isLockedOdds=true + seedSize); parimutuel when
    // they don't want to hand-price the line. The "no refunds /
    // never void with bets" guarantee on /api/markets/resolve covers
    // both engines from db6e811 — empty-pool cases resolve normally,
    // losers lose, the house keeps the pool. Refund as a settlement
    // outcome is gone on either path.

    // ── Locked-odds branch: validate seed + vig before insert ───────
    let lockedFields: Record<string, any> = {
      is_locked_odds: false,
      seed_pool: {},
      seed_probability: null,
      vig_pct: 0.08,
      is_paused: false,
    };

    if (isLockedOdds) {
      const seedSize = Number(seedSizeTngn);
      if (!Number.isFinite(seedSize) || seedSize < MIN_SEED_TNGN || seedSize > MAX_SEED_TNGN) {
        return NextResponse.json(
          { error: `Seed size must be between ₦${MIN_SEED_TNGN.toLocaleString()} and ₦${MAX_SEED_TNGN.toLocaleString()} tNGN` },
          { status: 400 },
        );
      }

      let binaryProb: number | null = null;
      if (options.length === 2) {
        const p = Number(seedProbability);
        if (!Number.isFinite(p) || p < MIN_SEED_PROB || p > MAX_SEED_PROB) {
          return NextResponse.json(
            { error: `Seed probability must be between ${MIN_SEED_PROB} and ${MAX_SEED_PROB}` },
            { status: 400 },
          );
        }
        binaryProb = p;
      }

      // Reserve check — the seed comes out of deployable capital.
      // We don't block at the floor (deployable can be near zero in
      // extreme states); we block at "seed exceeds deployable".
      const { data: reserve } = await supabaseAdmin
        .from('reserve_health')
        .select('deployable_tngn')
        .maybeSingle();
      const deployable = Number(reserve?.deployable_tngn ?? 0);
      if (seedSize > deployable) {
        return NextResponse.json(
          { error: `Seed of ₦${seedSize.toLocaleString()} exceeds deployable reserve of ₦${Math.round(deployable).toLocaleString()}` },
          { status: 400 },
        );
      }

      // Validated. Compose the locked-odds columns.
      const explicit = Array.isArray(seedPool)
        ? seedPool.map(Number).filter(v => Number.isFinite(v))
        : null;
      const pool = buildSeedPool(
        seedSize,
        options.length,
        binaryProb,
        explicit && explicit.length === options.length ? explicit : null,
      );

      let resolvedVig = 0.08;
      if (vigPct !== undefined && vigPct !== null && vigPct !== '') {
        const v = Number(vigPct);
        if (!Number.isFinite(v) || v < 0.04 || v > 0.15) {
          return NextResponse.json(
            { error: 'Vig must be between 0.04 (4%) and 0.15 (15%)' },
            { status: 400 },
          );
        }
        resolvedVig = v;
      }

      lockedFields = {
        is_locked_odds: true,
        seed_pool: pool,
        seed_probability: binaryProb,
        vig_pct: resolvedVig,
        is_paused: false,
      };
    }

    // Scheduling: if opensAt is set and is genuinely in the future, the
    // market goes in as 'scheduled' instead of 'open' — invisible to
    // every public list query until /api/markets/open-scheduled (cron,
    // every 5 min) flips it. published_at stays null until that flip so
    // the New/Trending feed can sort by "went live", not "was authored".
    let status = 'open';
    let opensAtIso: string | null = null;
    let publishedAtIso: string | null = new Date().toISOString();
    if (opensAt) {
      const parsedOpensAt = new Date(opensAt);
      if (isNaN(parsedOpensAt.getTime())) {
        return NextResponse.json({ error: 'Invalid opensAt' }, { status: 400 });
      }
      if (parsedOpensAt.getTime() > Date.now()) {
        status = 'scheduled';
        opensAtIso = parsedOpensAt.toISOString();
        publishedAtIso = null;
      }
    }

    const { data: market, error } = await supabaseAdmin
      .from('markets')
      .insert({
        title: title || question.slice(0, 80),
        question,
        category,
        options,
        closes_at: closesAt,
        status,
        opens_at: opensAtIso,
        published_at: publishedAtIso,
        parent_market_id: parentMarketId || null,
        fixture_id: fixtureId || null,
        is_jackpot_eligible: isJackpotEligible || false,
        sport: sport || 'football',
        home_team: homeTeam || null,
        away_team: awayTeam || null,
        league_code: leagueCode || null,
        description: description || null,
        total_pool: 0,
        created_at: new Date().toISOString(),
        ...lockedFields,
      })
      .select('id, title, question, category, closes_at, status, opens_at, sport, is_locked_odds, seed_pool, vig_pct')
      .single();

    if (error) {
      console.error('Failed to create market:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`Market created: ${market.id} — ${market.question}${market.is_locked_odds ? ' (locked-odds)' : ''}`);
    return NextResponse.json({ success: true, market }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { marketId, updates } = await request.json();
    if (!marketId || !updates) {
      return NextResponse.json({ error: 'Missing marketId or updates' }, { status: 400 });
    }
    const { error } = await supabaseAdmin.from('markets').update(updates).eq('id', marketId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
