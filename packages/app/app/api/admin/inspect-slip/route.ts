import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/inspect-slip?slipId=...      — one specific slip, full detail
// GET /api/admin/inspect-slip?userId=...       — every slip for a user
// GET /api/admin/inspect-slip?email=...        — every slip for a user, by email
// GET /api/admin/inspect-slip                  — every slip currently status='active',
//                                                across ALL users (the "what's actually
//                                                stuck right now" system-wide view)
// GET /api/admin/inspect-slip?allStatuses=true — same as above but every status, not just active
//
// Read-only ground truth: the raw multiplier_slips row plus every one
// of its multiplier_legs rows and the markets each leg points to, with
// no filtering or interpretation. When the UI shows something that
// doesn't match what a manual DB fix was supposed to produce, this is
// the fastest way to see whether the DATA is actually wrong or whether
// it's a display bug — no page cache, no realtime subscription, no
// client-side query logic in between.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const slipId = url.searchParams.get('slipId');
  const userIdParam = url.searchParams.get('userId');
  const emailParam = url.searchParams.get('email');
  const allStatuses = url.searchParams.get('allStatuses') === 'true';
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));

  let userId: string | null = userIdParam;
  if (!userId && emailParam) {
    const { data: u, error: uErr } = await supabaseAdmin
      .from('users').select('id, email').eq('email', emailParam.toLowerCase()).maybeSingle();
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    if (!u) return NextResponse.json({ error: `No user with email ${emailParam}` }, { status: 404 });
    userId = u.id;
  }

  let slipQuery = supabaseAdmin
    .from('multiplier_slips')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (slipId) slipQuery = slipQuery.eq('id', slipId);
  else if (userId) slipQuery = slipQuery.eq('user_id', userId);
  else if (!allStatuses) slipQuery = slipQuery.eq('status', 'active'); // default: system-wide, currently-stuck view

  const { data: slips, error: slipErr } = await slipQuery;
  if (slipErr) return NextResponse.json({ error: slipErr.message }, { status: 500 });
  if (!slips || slips.length === 0) {
    return NextResponse.json({ found: 0, slips: [], note: 'No matching slip(s) found.' });
  }

  const slipIds = slips.map(s => s.id);
  const { data: legs, error: legErr } = await supabaseAdmin
    .from('multiplier_legs')
    .select('*')
    .in('slip_id', slipIds)
    .order('id', { ascending: true });
  if (legErr) return NextResponse.json({ error: legErr.message }, { status: 500 });

  const marketIds = Array.from(new Set((legs || []).map(l => l.market_id)));
  const { data: markets, error: mErr } = marketIds.length > 0
    ? await supabaseAdmin.from('markets').select('id, question, status, resolved_outcome, resolved_outcomes, closes_at, resolved_at').in('id', marketIds)
    : { data: [] as any[], error: null };
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
  const marketById = Object.fromEntries((markets || []).map(m => [m.id, m]));

  const result = slips.map(s => {
    const slipLegs = (legs || []).filter(l => l.slip_id === s.id).map(l => ({
      ...l,
      market: marketById[l.market_id] || null,
    }));
    const allLegsSettled = slipLegs.length > 0 && slipLegs.every(l => l.status !== 'active');
    const anyLegOnUnresolvedMarket = slipLegs.some(l => l.status === 'active' && l.market && l.market.status !== 'resolved' && l.market.status !== 'voided');
    const anyLegOrphaned = slipLegs.some(l => l.status === 'active' && l.market && (l.market.status === 'resolved' || l.market.status === 'voided'));
    return {
      slip: s,
      legCountStored: s.legs_total,
      legCountFound: slipLegs.length,
      legCountMismatch: s.legs_total !== slipLegs.length,
      // The sharpest signal for "frontend won't update no matter what":
      // every leg already has a final status (won/lost/void), yet the
      // SLIP row itself is still 'active' — meaning settle_multiplier_
      // for_market updated the legs but never advanced/finalized the
      // parent slip. No UI fix or refresh can help this; the slip row
      // itself needs its status/legs_resolved/legs_won recomputed.
      allLegsSettledButSlipStillActive: s.status === 'active' && allLegsSettled,
      // A genuinely still-pending slip: at least one leg is 'active' and
      // sitting on a market that hasn't resolved/voided yet. Expected,
      // not a bug — nothing to do until that market resolves.
      genuinelyWaitingOnMarket: s.status === 'active' && anyLegOnUnresolvedMarket,
      // Same fingerprint diagnose-recent-resolutions calls orphaned_legs:
      // a leg is 'active' but its market already finished — the repair
      // tools (repair-multiplier-legs / re-resolve-voided-market) are
      // what fixes this one.
      anyLegOrphanedOnFinishedMarket: anyLegOrphaned,
      legs: slipLegs,
    };
  });

  const summary = {
    total: result.length,
    allLegsSettledButSlipStillActive: result.filter(r => r.allLegsSettledButSlipStillActive).length,
    anyLegOrphanedOnFinishedMarket: result.filter(r => r.anyLegOrphanedOnFinishedMarket).length,
    genuinelyWaitingOnMarket: result.filter(r => r.genuinelyWaitingOnMarket).length,
    legCountMismatch: result.filter(r => r.legCountMismatch).length,
  };

  return NextResponse.json({
    found: result.length,
    summary,
    slips: result,
    note: 'Raw, unfiltered rows. Check summary first: allLegsSettledButSlipStillActive means the legs are fine but the SLIP row itself never finalized (needs a direct fix, not a re-settle); anyLegOrphanedOnFinishedMarket means a leg is stuck active on an already-finished market (repair-multiplier-legs fixes this); legCountMismatch means legs_total does not match the actual number of leg rows, so the slip can never complete no matter what runs.',
  });
}
