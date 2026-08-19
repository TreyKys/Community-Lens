import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET  /api/open-markets/creator — everything a creator needs about their own
//                                  markets: status, review notes, earnings.
// POST /api/open-markets/creator — claim what is owed on one of them.
//
// The threshold is the whole incentive of this feature, and up to now it was
// invisible to the one person it is meant to motivate. Progress toward it is
// returned as a fraction so the UI can show it as a goal being approached
// rather than a penalty being applied.

export async function GET(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('open_markets_creator_summary')
    .select('*')
    .eq('created_by', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let totalEarned = 0, totalClaimable = 0, totalFees = 0;

  const markets = (data || []).map((m: any) => {
    const fees = Number(m.fees_collected || 0);
    const threshold = Number(m.threshold_tngn || 0);
    const claimable = Math.max(0, Number(m.claimable_tngn || 0));
    totalEarned += Number(m.creator_paid || 0);
    totalClaimable += claimable;
    totalFees += fees;
    return {
      id: m.id,
      question: m.question,
      category: m.category,
      outcomes: m.outcomes,
      status: m.status,
      // Only surfaced for revise/rejected: notes on an approved market are
      // internal reviewer shorthand, not a message to the creator.
      reviewNotes: ['revise', 'rejected'].includes(m.status) ? m.review_notes : null,
      reviewScore: ['revise', 'rejected'].includes(m.status) ? m.review_score : null,
      createdAt: m.created_at,
      openedAt: m.opened_at,
      resolvedAt: m.resolved_at,
      tradingClosesAt: m.trading_closes_at,
      horizonAt: m.horizon_at,
      traders: Number(m.traders || 0),
      trades: Number(m.trades || 0),
      feesTngn: fees,
      thresholdTngn: threshold,
      thresholdProgress: threshold > 0 ? Math.min(1, fees / threshold) : 0,
      // What is still needed before a single naira is shared. Shown directly
      // because "you need ₦4,200 more in fees" is actionable and a percentage
      // is not.
      feesToThresholdTngn: Math.max(0, threshold - fees),
      earnedTngn: Number(m.creator_accrued || 0),
      paidTngn: Number(m.creator_paid || 0),
      claimableTngn: claimable,
    };
  });

  return NextResponse.json({
    markets,
    totals: { earnedTngn: totalEarned, claimableTngn: totalClaimable, feesTngn: totalFees },
  }, { headers: { 'Cache-Control': 'no-store' } });
}


export async function POST(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const marketId = String(body?.marketId || '');
  if (!marketId) return NextResponse.json({ error: 'Missing market' }, { status: 400 });

  // Ownership, the threshold, and the replay of accrued against the fee log
  // are all checked inside the RPC under the market row lock — a check here
  // would be one two concurrent taps could both pass.
  const { data, error } = await supabaseAdmin.rpc('claim_creator_earnings', {
    p_market_id: marketId,
    p_user_id: user.id,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    return NextResponse.json({ error: row?.reason || 'Could not pay out' }, { status: 400 });
  }

  return NextResponse.json({
    paidTngn: Number(row.paid_tngn || 0),
    remainingTngn: Number(row.remaining_tngn || 0),
  });
}
