import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';
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
  const eventTag = searchParams.get('eventTag');
  const limit = Math.min(Number(searchParams.get('limit') || 40), 100);

  let base = supabaseAdmin
    .from('open_markets')
    .select('id, question, description, category, outcomes, q, b, status, ' +
            'horizon_at, trading_closes_at, fees_collected, created_at, opened_at, event_tag')
    // Only states a user can act on or learn from. pending_review and rejected
    // are deliberately invisible — an unapproved market must not be discoverable.
    .in('status', ['open', 'horizon_window', 'closed', 'pending_payout', 'resolved']);

  // Filter BEFORE .returns(): that call closes the builder, so any .eq() after
  // it no longer type-checks.
  if (category) base = base.eq('category', category);
  // Hub pages (e.g. /bbn) pass this instead of/alongside category — it's the
  // engine-agnostic routing tag, independent of the locked-odds sport/
  // league_code mechanism this table doesn't have.
  if (eventTag) base = base.eq('event_tag', eventTag.toLowerCase());

  const { data, error } = await base
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
      eventTag: m.event_tag,
    };
  });

  return NextResponse.json({ markets }, { headers: { 'Cache-Control': 'no-store' } });
}


// POST /api/open-markets — a user submits a market for review.
//
// It lands in pending_review and is invisible to everyone but admins until an
// approver opens it. Nothing here can open a book: liquidity, the trading
// cut-off and the exposure check are all decided at approval, because choosing
// your own liquidity is choosing the house's maximum loss on your market.
//
// Every content rule lives in submit_open_market, not here — the category
// allowlist, the outcome rules, the queue limit. A rule enforced in this route
// is a rule the admin submit path doesn't have.

export async function POST(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const b = await request.json().catch(() => ({} as any));
  const outcomes = Array.isArray(b?.outcomes)
    ? b.outcomes.map((o: unknown) => String(o).trim()).filter(Boolean)
    : [];

  const { data, error } = await supabaseAdmin.rpc('submit_open_market', {
    p_created_by: user.id,
    p_question: String(b?.question || ''),
    p_description: b?.description ? String(b.description) : null,
    p_category: String(b?.category || ''),
    p_outcomes: outcomes,
    p_resolution_source: String(b?.resolutionSource || ''),
    p_resolution_detail: b?.resolutionDetail ? String(b.resolutionDetail) : null,
    p_horizon_at: b?.horizonAt || null,
    p_trading_closes_at: b?.tradingClosesAt || null,
    p_event_tag: b?.eventTag ? String(b.eventTag) : null,
    // Same person on a user submission — they are both the creator and
    // the submitter, so both guards catch them.
    p_submitted_by: user.id,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    // Refusals are things the submitter can fix, so they come back as a
    // readable sentence rather than a server error.
    return NextResponse.json({ error: row?.reason || 'Could not submit' }, { status: 400 });
  }

  await supabaseAdmin.from('notifications').insert({
    user_id: user.id,
    type: 'open_market_submitted',
    message: 'Your market is with our reviewers. We usually decide within a day.',
    severity: 'info',
    action_url: '/open/creator',
  });

  return NextResponse.json({ marketId: row.market_id, status: 'pending_review' });
}
