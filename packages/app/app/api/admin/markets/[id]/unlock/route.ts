import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/markets/[id]/unlock
//
// Manual escape hatch for a market that locked too early (cron fired on
// a stale closes_at, admin fat-fingered a force-lock, etc). Reopens it
// for betting and pushes closes_at out to a new admin-chosen time so it
// doesn't immediately re-lock on the next cron tick.
//
// Only callable on status='locked' — open markets don't need unlocking,
// and resolved/voided markets are settled (bets paid/refunded); reopening
// those would let people stake into a market whose outcome is already
// decided, so that's refused outright rather than offered as a "force".
//
// Clears merkle_root: that column is read by the client purely as "this
// market is sealed" (MarketList's "Prediction ledger sealed on Polygon"
// badge, bets/page.tsx's isLocked flag). The merkle_commits row from the
// original lock stays in the table untouched — it's a true historical
// record of a commit that happened — but the market no longer points at
// it as current once betting reopens. Locking again later inserts a
// fresh commit and re-sets merkle_root.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const marketId = Number(params.id);
  if (!Number.isFinite(marketId)) {
    return NextResponse.json({ error: 'id must be a number' }, { status: 400 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  if (typeof body?.closesAt !== 'string') {
    return NextResponse.json({ error: 'closesAt (ISO timestamp) is required' }, { status: 400 });
  }
  const t = Date.parse(body.closesAt);
  if (!Number.isFinite(t)) {
    return NextResponse.json({ error: 'closesAt is not a valid timestamp' }, { status: 400 });
  }
  if (t <= Date.now()) {
    return NextResponse.json({ error: 'closesAt must be in the future — otherwise the market reopens and immediately looks overdue again' }, { status: 400 });
  }

  const { data: market, error: fetchErr } = await supabaseAdmin
    .from('markets')
    .select('id, status')
    .eq('id', marketId)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message || 'Could not read market' }, { status: 500 });
  if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (market.status !== 'locked') {
    return NextResponse.json(
      { error: `Market is ${market.status}, not locked — only locked markets can be unlocked.` },
      { status: 409 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from('markets')
    .update({ status: 'open', closes_at: new Date(t).toISOString(), merkle_root: null })
    .eq('id', marketId)
    .select('id, status, closes_at, merkle_root')
    .maybeSingle();

  if (error) {
    console.error('admin market-unlock error', error);
    return NextResponse.json({ error: error.message || 'Unlock failed' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  return NextResponse.json({ ok: true, market: data });
}
