import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';
import { type OpenMarketRow, type OpenPositionRow, pricesFromQ, volumeFromFees } from '@/lib/openMarketTypes';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);


// GET /api/open-markets/[id] — one market, plus the caller's own position.
//
// The price history comes from open_trades.price_after, which every trade
// records. No candle table: at this volume it would be more machinery than
// signal, and a sparse chart on a three-trade market is honest.

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const { data: m, error } = await supabaseAdmin
    .from('open_markets')
    .select('id, question, description, category, outcomes, q, q_initial, b, status, ' +
            'resolution_source, resolution_detail, horizon_at, horizon_count, ' +
            'horizon_window_closes_at, trading_closes_at, resolved_outcome, ' +
            'dispute_window_hours, settlement_locked_until, fees_collected, ' +
            'created_by, opened_at, resolved_at')
    .eq('id', params.id)
    .maybeSingle<OpenMarketRow>();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!m) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (['pending_review', 'revise', 'rejected'].includes(m.status)) {
    // Unapproved markets are not public. Returning 404 rather than 403 avoids
    // confirming that a rejected submission exists.
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  }

  const prices = pricesFromQ(m.q, m.b);

  // Public tape — no user_id, no naira amounts per trader.
  const { data: tape } = await supabaseAdmin
    .from('open_trades')
    .select('outcome_idx, price_after, created_at')
    .eq('market_id', params.id)
    .order('created_at', { ascending: true })
    .limit(200);

  // The caller's own position, if signed in. Never anyone else's.
  let position: any = null;
  const user = await getAuthUser(supabaseAdmin, request);
  if (user) {
    const { data: pos } = await supabaseAdmin
      .from('open_positions')
      .select('id, outcome_idx, shares_cash, shares_bonus, cost_cash, status')
      .eq('market_id', params.id)
      .eq('user_id', user.id)
      .gt('shares_cash', 0)
      .returns<OpenPositionRow[]>();

    position = (pos || []).map(p => {
      const shares = Number(p.shares_cash) + Number(p.shares_bonus);
      const basis = Number(p.cost_cash);
      const markValue = shares * prices[p.outcome_idx];
      return {
        positionId: p.id,
        outcomeIdx: p.outcome_idx,
        outcomeLabel: m.outcomes[p.outcome_idx],
        shares,
        costBasisTngn: basis,
        // Mark-to-market. Deliberately labelled as an estimate in the UI:
        // actually exiting moves the price against you, and the quote endpoint
        // is the only place that tells the truth about what a sale realises.
        markValueTngn: markValue,
        unrealisedPnlTngn: markValue - basis,
        status: p.status,
      };
    });
  }

  return NextResponse.json({
    market: {
      id: m.id,
      question: m.question,
      description: m.description,
      category: m.category,
      outcomes: m.outcomes,
      prices,
      status: m.status,
      resolutionSource: m.resolution_source,
      resolutionDetail: m.resolution_detail,
      horizonAt: m.horizon_at,
      horizonCount: m.horizon_count,
      horizonWindowClosesAt: m.horizon_window_closes_at,
      tradingClosesAt: m.trading_closes_at,
      resolvedOutcome: m.resolved_outcome,
      settlementLockedUntil: m.settlement_locked_until,
      volumeTngn: volumeFromFees(m.fees_collected),
      // Surfaced so the UI can explain WHY the trade button is disabled for
      // this one account, rather than failing at submit with a raw error.
      isCreator: !!(user && m.created_by && user.id === m.created_by),
      openedAt: m.opened_at,
      resolvedAt: m.resolved_at,
    },
    priceHistory: (tape || []).map(t => ({
      outcomeIdx: t.outcome_idx,
      price: Number(t.price_after),
      at: t.created_at,
    })),
    position,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
