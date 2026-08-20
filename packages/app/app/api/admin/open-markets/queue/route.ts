import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/open-markets/queue
//
// Submissions awaiting a decision, with the creator's track record inline.
// "Has this person had a market resolve cleanly before" is the single most
// useful thing a reviewer can know, and if it takes a separate lookup per
// submission it stops getting looked up by market number forty.
//
// Read-only. The decision itself goes through /review, which is the only path
// that can open a book.

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: rows, error } = await supabaseAdmin
    .from('open_markets_review_queue')
    .select('*')
    .order('created_at', { ascending: true });   // oldest first — a queue, not a feed

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Prior decisions on these same markets, so a resubmission shows what was
  // asked for last time instead of being re-reviewed from scratch.
  const ids = (rows || []).map((r: any) => r.id);
  let historyByMarket: Record<string, any[]> = {};
  if (ids.length) {
    const { data: hist } = await supabaseAdmin
      .from('open_market_reviews')
      .select('market_id, decision, score, hard_gate, notes, created_at')
      .in('market_id', ids)
      .order('created_at', { ascending: false });
    for (const h of (hist || []) as any[]) {
      (historyByMarket[h.market_id] ||= []).push(h);
    }
  }

  const { data: cfg } = await supabaseAdmin
    .from('open_markets_config')
    .select('trading_enabled, disabled_reason, max_total_exposure_tngn, max_market_b_tngn, allowed_categories')
    .eq('id', 1)
    .maybeSingle();

  const { data: exposure } = await supabaseAdmin
    .from('open_markets_exposure')
    .select('*')
    .maybeSingle();

  const committed = Number((exposure as any)?.worst_case_tngn || 0);
  const cap = Number((cfg as any)?.max_total_exposure_tngn || 0);

  return NextResponse.json({
    submissions: (rows || []).map((r: any) => ({
      id: r.id,
      question: r.question,
      description: r.description,
      category: r.category,
      outcomes: r.outcomes,
      resolutionSource: r.resolution_source,
      resolutionDetail: r.resolution_detail,
      horizonAt: r.horizon_at,
      tradingClosesAt: r.trading_closes_at,
      status: r.status,
      createdAt: r.created_at,
      eventTag: r.event_tag,
      creator: {
        id: r.created_by,
        handle: r.creator_handle,
        email: r.creator_email,
        resolved: Number(r.creator_resolved || 0),
        rejected: Number(r.creator_rejected || 0),
        voided: Number(r.creator_voided || 0),
        disputes: Number(r.creator_disputes || 0),
      },
      history: historyByMarket[r.id] || [],
    })),
    config: cfg || null,
    // Surfaced next to the queue because approving is what spends it. A
    // reviewer who can't see the remaining budget will approve into the cap
    // and get a refusal they can't interpret.
    exposure: {
      committedTngn: committed,
      capTngn: cap,
      headroomTngn: Math.max(0, cap - committed),
      liveMarkets: Number((exposure as any)?.live_markets || 0),
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
