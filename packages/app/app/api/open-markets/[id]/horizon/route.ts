import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/open-markets/[id]/horizon
// Body: { positionId: uuid, choice: 'roll' | 'cash_out' }
//
// A horizon is a scheduled REVIEW date, not a resolution date. It is the
// mechanism that stops a market with no known end from trapping anyone's
// money: at each one you either stay in or take your money out.
//
// DOING NOTHING MEANS STAYING IN. That is deliberate — we never move someone's
// money without them asking. The consequence is that this endpoint only ever
// records an active choice, and its absence is meaningful.
//
// The window closes on the clock inside record_horizon_election, not here: a
// late election must be refused server-side, or someone could decide after
// watching the first payouts land.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const positionId = String(body?.positionId || '');
  const choice = String(body?.choice || '');

  if (!positionId) return NextResponse.json({ error: 'Missing position' }, { status: 400 });
  if (choice !== 'roll' && choice !== 'cash_out') {
    return NextResponse.json({ error: 'Choose stay in or cash out' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('record_horizon_election', {
    p_market_id: params.id,
    p_user_id: user.id,
    p_position_id: positionId,
    p_choice: choice,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    // The RPC returns a reason rather than raising for expected refusals
    // (window closed, not your position, no window open) — those are 400s the
    // user can understand, not server errors.
    return NextResponse.json({ error: row?.reason || 'Could not record your choice' }, { status: 400 });
  }

  return NextResponse.json({ choice: row.choice, recorded: true });
}
