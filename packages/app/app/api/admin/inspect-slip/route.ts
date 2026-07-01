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

  let userId: string | null = userIdParam;
  if (!userId && emailParam) {
    const { data: u, error: uErr } = await supabaseAdmin
      .from('users').select('id, email').eq('email', emailParam.toLowerCase()).maybeSingle();
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    if (!u) return NextResponse.json({ error: `No user with email ${emailParam}` }, { status: 404 });
    userId = u.id;
  }

  if (!slipId && !userId) {
    return NextResponse.json({ error: 'Provide slipId, userId, or email' }, { status: 400 });
  }

  let slipQuery = supabaseAdmin
    .from('multiplier_slips')
    .select('*')
    .order('created_at', { ascending: false });
  slipQuery = slipId ? slipQuery.eq('id', slipId) : slipQuery.eq('user_id', userId!);

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
    return {
      slip: s,
      legCountStored: s.legs_total,
      legCountFound: slipLegs.length,
      legCountMismatch: s.legs_total !== slipLegs.length,
      legs: slipLegs,
    };
  });

  return NextResponse.json({
    found: result.length,
    slips: result,
    note: 'Raw, unfiltered rows — this is exactly what is in the database right now. legCountMismatch=true means legs_total on the slip does not match the number of multiplier_legs rows actually found for it (a leg is missing, or extra rows exist) — that alone would explain a slip that never completes no matter what settle_multiplier_for_market does, since it is counting against a total that does not match reality.',
  });
}
