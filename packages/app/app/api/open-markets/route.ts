import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { type OpenMarketListRow, pricesFromQ, volumeFromFees } from '@/lib/openMarketTypes';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/open-markets — the browse list.
//
// Open Markets are a SEPARATE category from the existing engines. Shares pay
// ₦1 if the outcome happens and ₦0 if it doesn't, and can be sold before the
// question resolves — which is what makes a market with no known end date
// viable at all.
//
// Public data only. open_trades is owner-only at the RLS layer, so nothing
// here can leak another user's position or wallet size.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  const limit = Math.min(Number(searchParams.get('limit') || 40), 100);

  const base = supabaseAdmin
    .from('open_markets')
    .select('id, question, description, category, outcomes, q, b, status, ' +
            'horizon_at, trading_closes_at, fees_collected, created_at, opened_at')
    // Only states a user can act on or learn from. pending_review and rejected
    // are deliberately invisible — an unapproved market must not be discoverable.
    .in('status', ['open', 'horizon_window', 'closed', 'pending_payout', 'resolved']);

  // Filter BEFORE .returns(): that call closes the builder, so any .eq() after
  // it no longer type-checks.
  const filtered = category ? base.eq('category', category) : base;

  const { data, error } = await filtered
    .order('opened_at', { ascending: false, nullsFirst: false })
    .limit(limit)
    .returns<OpenMarketListRow[]>();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Price the whole list in one round trip rather than one RPC per market.
  const markets = (data || []).map(m => {
    const prices = pricesFromQ(m.q, m.b);
    return {
      id: m.id,
      question: m.question,
      description: m.description,
      category: m.category,
      outcomes: m.outcomes,
      prices,                                   // 0..1, always sums to 1
      status: m.status,
      horizonAt: m.horizon_at,
      tradingClosesAt: m.trading_closes_at,
      // Volume proxy: fees are 1.5% of trade value, so this is a reasonable
      // public activity signal without exposing anyone's individual flow.
      volumeTngn: volumeFromFees(m.fees_collected),
      openedAt: m.opened_at,
    };
  });

  return NextResponse.json({ markets }, { headers: { 'Cache-Control': 'no-store' } });
}
