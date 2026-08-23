import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/open-markets/submit
//
// House-authored submissions. They land in pending_review exactly like a user's
// and still have to pass the same gate — which is the point. A separate "admin
// creates a market directly" path would be the one route that skips the
// exposure cap, the trading cut-off check and the category allowlist, and it
// would become the default because it's fewer clicks.
//
// createdBy omitted means a HOUSE market: no creator, so no creator fee accrual
// and no self-approval question. Passing a user id attributes it to them, and
// four-eyes then forbids that person from being the reviewer.

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const b = await request.json().catch(() => ({} as any));

  // WHO submitted this, recorded separately from who earns from it.
  //
  // A house market has createdBy null so no fee share accrues — but every
  // insider guard used to key off created_by alone, so null disabled all of
  // them and one admin could submit, approve, trade and resolve the same
  // market. submitted_by is what keeps four eyes meaningful when nobody is
  // being paid a share. Refusing without it is deliberate: an unattributed
  // house market is exactly the thing that hole was made of.
  const sessionUser = await getAuthUser(supabaseAdmin, request);
  const submittedBy = sessionUser?.id
    || String(b?.submittedBy || '')
    || process.env.ADMIN_REVIEWER_USER_ID
    || '';
  if (!submittedBy) {
    return NextResponse.json({
      error: 'No submitter identity. Sign in, or set ADMIN_REVIEWER_USER_ID.',
    }, { status: 400 });
  }
  const outcomes = Array.isArray(b?.outcomes)
    ? b.outcomes.map((o: unknown) => String(o))
    : [];

  if (outcomes.length < 2) {
    return NextResponse.json({ error: 'A market needs at least 2 outcomes' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('submit_open_market', {
    p_created_by: b?.createdBy || null,
    p_question: String(b?.question || ''),
    p_description: b?.description ? String(b.description) : null,
    p_category: String(b?.category || ''),
    p_outcomes: outcomes,
    p_resolution_source: String(b?.resolutionSource || ''),
    p_resolution_detail: b?.resolutionDetail ? String(b.resolutionDetail) : null,
    p_horizon_at: b?.horizonAt || null,
    p_trading_closes_at: b?.tradingClosesAt || null,
    p_event_tag: b?.eventTag ? String(b.eventTag) : null,
    p_submitted_by: submittedBy,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    return NextResponse.json({ error: row?.reason || 'Could not submit' }, { status: 400 });
  }

  return NextResponse.json({ marketId: row.market_id, status: 'pending_review' });
}
