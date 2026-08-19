import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/open-markets/[id]/dispute
// Body: { reason: string }
//
// A dispute only means anything DURING the dispute window. That is the whole
// reason payouts are computed and then held: once money lands in a withdrawable
// balance it cannot be clawed back, so a complaint afterwards has nothing to
// act on. An open dispute blocks release, which is what gives this teeth.
//
// Restricted to people who actually traded the market. Otherwise it is a free
// lever anyone can pull to freeze someone else's payout.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const reason = String(body?.reason || '').trim();

  const { data, error } = await supabaseAdmin.rpc('raise_open_market_dispute', {
    p_market_id: params.id,
    p_user_id: user.id,
    p_reason: reason,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    return NextResponse.json({ error: row?.reason || 'Could not raise this' }, { status: 400 });
  }

  return NextResponse.json({ disputeId: row.dispute_id, raised: true });
}
