import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';
import { normalizeNigerianPhone } from '@/lib/termii';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET  /api/rewards — the five one-off profile rewards and their state
// POST /api/rewards — claim one: { rewardId, handle?, phone? }
//
// The amounts live in reward_catalogue() in the database, never here. A reward
// value in application code is a value that can disagree with the one actually
// paid, and the one actually paid is the one in the RPC.

export async function GET(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const { data, error } = await supabaseAdmin.rpc('get_reward_state', {
    p_user_id: user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rewards = (data || []).map((r: any) => ({
    id: r.reward_id,
    label: r.label,
    detail: r.detail,
    rewardTngn: Number(r.reward_tngn),
    needsHandle: !!r.needs_handle,
    url: r.url,
    status: r.status as 'available' | 'pending' | 'paid' | 'revoked',
    handle: r.handle,
  }));

  return NextResponse.json({
    rewards,
    availableTngn: rewards
      .filter((r: any) => r.status === 'available')
      .reduce((s: number, r: any) => s + r.rewardTngn, 0),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const rewardId = String(body?.rewardId || '');
  if (!rewardId) return NextResponse.json({ error: 'Missing reward' }, { status: 400 });

  let phone: string | null = null;
  if (rewardId === 'phone') {
    // Normalised to E.164 before it is stored, so the UNIQUE index actually
    // does its job: 08031234567 and +2348031234567 are the same number, and
    // storing them raw would let one person register both.
    phone = normalizeNigerianPhone(String(body?.phone || ''));
    if (!phone) {
      return NextResponse.json({
        error: 'That does not look like a Nigerian number',
      }, { status: 400 });
    }
  }

  const { data, error } = await supabaseAdmin.rpc('claim_profile_reward', {
    p_user_id: user.id,
    p_reward_id: rewardId,
    p_handle: body?.handle ? String(body.handle).trim() : null,
    p_phone: phone,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    return NextResponse.json({ error: row?.reason || 'Could not claim' }, { status: 400 });
  }

  return NextResponse.json({
    status: row.status,
    rewardTngn: Number(row.reward_tngn || 0),
  });
}
