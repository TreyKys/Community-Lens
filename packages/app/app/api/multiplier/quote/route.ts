import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { calculateLockedOdds } from '@/lib/lockedOdds';
import { validateSlip, quoteSlip, MULT_LEG_PRICING_REFERENCE_STAKE, type SlipLegInput } from '@/lib/multiplier';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/multiplier/quote
//
// Live preview as the user builds a slip. Prices each leg with the
// SAME calculateLockedOdds the placement RPC's SQL twin uses (parity-
// tested), at the same FIXED reference stake the RPC uses (never the
// real slip stake — see MULT_LEG_PRICING_REFERENCE_STAKE), so the
// quote the user sees matches what gets placed. Does NOT touch any
// balance, Boost, or pool — pure read + math.
//
// Body: { slipStake, legs: [{ marketId, outcomeIndex }] }
export async function POST(request: Request) {
  try {
    let body: any;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Malformed request body' }, { status: 400 }); }

    const slipStake = Number(body?.slipStake);
    const legs = Array.isArray(body?.legs) ? body.legs : null;
    if (!Number.isFinite(slipStake) || slipStake <= 0 || !legs || legs.length === 0) {
      return NextResponse.json({ error: 'slipStake and legs are required' }, { status: 400 });
    }

    // Reserve snapshot (server-side; RLS-hidden from the browser).
    const { data: reserve } = await supabaseAdmin
      .from('reserve_health')
      .select('deployable_tngn, floor_tngn')
      .maybeSingle();
    const reserveCtx = {
      deployableTngn: Number(reserve?.deployable_tngn ?? 120_000),
      floorTngn: Number(reserve?.floor_tngn ?? 30_000),
    };

    // Price each leg.
    const priced: SlipLegInput[] = [];
    const legDetail: any[] = [];
    for (const l of legs) {
      const marketId = Number(l?.marketId);
      const outcomeIndex = Number(l?.outcomeIndex);
      if (!Number.isInteger(marketId) || !Number.isInteger(outcomeIndex) || outcomeIndex < 0) {
        return NextResponse.json({ error: 'Each leg needs a valid marketId and outcomeIndex' }, { status: 400 });
      }

      const { data: market } = await supabaseAdmin
        .from('markets')
        .select('options, seed_pool, pool_by_outcome, category, vig_pct, is_locked_odds, status, closes_at')
        .eq('id', marketId)
        .maybeSingle();

      if (!market) return NextResponse.json({ error: `Market ${marketId} not found`, leg: marketId }, { status: 404 });
      if (!market.is_locked_odds) {
        return NextResponse.json({ error: `Market ${marketId} isn’t eligible for Multipliers`, leg: marketId }, { status: 400 });
      }

      const options = market.options as string[];
      const seedMap = (market.seed_pool || {}) as Record<string, number>;
      const poolMap = (market.pool_by_outcome || {}) as Record<string, number>;
      const seedPool = options.map((_, i) => Number(seedMap[String(i)] ?? 0));
      const realPool = options.map((_, i) => Number(poolMap[String(i)] ?? 0));

      // Price at the FIXED reference stake, never the real slip stake
      // — a parlay leg's odds must not depend on how much the user is
      // staking on the slip (see MULT_LEG_PRICING_REFERENCE_STAKE).
      let calc;
      try {
        calc = calculateLockedOdds(
          { category: market.category, seedPool, realPool, vigPctOverride: market.vig_pct == null ? undefined : Number(market.vig_pct) },
          MULT_LEG_PRICING_REFERENCE_STAKE,
          outcomeIndex,
          {},
          reserveCtx,
        );
      } catch {
        return NextResponse.json({ error: `Couldn’t price market ${marketId}`, leg: marketId }, { status: 400 });
      }

      priced.push({ marketId, outcomeIndex, lockedOdds: calc.lockedOdds, vigAtStakePct: calc.vigApplied });
      legDetail.push({
        marketId,
        outcomeIndex,
        option: options[outcomeIndex],
        lockedOdds: calc.lockedOdds,
        open: market.status === 'open' && new Date(market.closes_at) > new Date(),
      });
    }

    // Validate + quote.
    const validation = validateSlip(priced, slipStake);
    if (!validation.ok) {
      return NextResponse.json({
        ok: false,
        error: validation.error,
        detail: validation.detail,
        legs: legDetail,
      }, { status: 200 }); // 200 — it's a live-preview "not yet valid", not a failure
    }

    const quote = quoteSlip(priced, slipStake);
    return NextResponse.json({
      ok: true,
      legs: legDetail,
      combinedOdds: quote.effectiveCombinedOdds,
      rawCombinedOdds: quote.combinedOdds,
      payout: quote.payoutTngn,
      netStake: quote.netSlipStake,
      tier: quote.tier,
      capBound: quote.capBound,
    }, { status: 200 });
  } catch (e: any) {
    console.error('Multiplier quote error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
