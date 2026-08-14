import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';
import { type OpenPositionRow, pricesFromQ } from '@/lib/openMarketTypes';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/open-markets/portfolio — the caller's own positions.
//
// A tradeable position does not fit the existing Live / Correct / Missed tabs
// on the bets page: those describe a bet that is waiting for one answer, and
// this is a holding whose value moves continuously and can be exited early.
// So it gets its own surface rather than being forced into a shape that would
// mislabel it.

export async function GET(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const { data: positions, error } = await supabaseAdmin
    .from('open_positions')
    .select('id, market_id, outcome_idx, shares_cash, shares_bonus, cost_cash, status, settled_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .returns<OpenPositionRow[]>();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const marketIds = Array.from(new Set((positions || []).map(p => p.market_id)));
  if (marketIds.length === 0) {
    return NextResponse.json({ open: [], closed: [], totals: { costTngn: 0, valueTngn: 0, pnlTngn: 0 } });
  }

  const { data: markets } = await supabaseAdmin
    .from('open_markets')
    .select('id, question, outcomes, q, b, status, horizon_at, horizon_window_closes_at, resolved_outcome')
    .in('id', marketIds);

  const byId: Record<string, any> = {};
  for (const m of (markets || []) as any[]) {
    byId[m.id] = { ...m, prices: pricesFromQ(m.q, m.b) };
  }

  const open: any[] = [];
  const closed: any[] = [];
  let costTngn = 0, valueTngn = 0;

  for (const p of positions || []) {
    const m = byId[p.market_id];
    if (!m) continue;
    const shares = Number(p.shares_cash) + Number(p.shares_bonus);
    const basis = Number(p.cost_cash);
    const price = m.prices[p.outcome_idx] ?? 0;

    const row = {
      positionId: p.id,
      marketId: p.market_id,
      question: m.question,
      outcomeLabel: m.outcomes[p.outcome_idx],
      outcomeIdx: p.outcome_idx,
      shares,
      costBasisTngn: basis,
      currentPrice: price,
      // Estimate only — the quote endpoint is the sole source of truth for
      // what a sale actually realises, because exiting moves the price.
      markValueTngn: shares * price,
      unrealisedPnlTngn: shares * price - basis,
      marketStatus: m.status,
      // Surfaced so a horizon deadline is visible from the portfolio, not only
      // from a notification the user may have missed.
      horizonAt: m.horizon_at,
      horizonWindowClosesAt: m.horizon_window_closes_at,
      needsHorizonChoice: m.status === 'horizon_window',
      status: p.status,
      settledAt: p.settled_at,
    };

    if (p.status === 'open' && shares > 0) {
      open.push(row);
      costTngn += basis;
      valueTngn += shares * price;
    } else {
      closed.push(row);
    }
  }

  return NextResponse.json({
    open, closed,
    totals: {
      costTngn,
      valueTngn,
      pnlTngn: valueTngn - costTngn,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
