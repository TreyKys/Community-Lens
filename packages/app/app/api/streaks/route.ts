import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET  /api/streaks — all five streaks with progress
// POST /api/streaks — claim one, { streakId }
//
// The GET also RECORDS the visit, which is what makes the login streak work at
// all: there is no other moment that reliably means "this person opened the
// app today". Doing it here rather than on sign-in also catches the returning
// user whose session never expired and so never signs in again.

export async function GET(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  // Fire and continue. A failed write costs one day of streak, which is
  // recoverable; blocking the response on it would cost the whole screen.
  try {
    await supabaseAdmin.rpc('record_streak_activity', {
      p_user_id: user.id, p_opened: true,
      p_staked_tngn: 0, p_is_trade: false, p_category: null,
    });
  } catch { /* non-fatal by design */ }

  const { data, error } = await supabaseAdmin.rpc('get_streak_state', {
    p_user_id: user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const streaks = (data || []).map((s: any) => ({
    id: s.streak_id,
    label: s.label,
    detail: s.detail,
    progress: Number(s.progress),
    target: Number(s.target),
    rewardTngn: Number(s.reward_tngn),
    claimable: !!s.claimable,
    claimed: !!s.claimed,
  }));

  return NextResponse.json({
    streaks,
    claimableCount: streaks.filter((s: any) => s.claimable).length,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const streakId = String(body?.streakId || '');
  if (!streakId) return NextResponse.json({ error: 'Missing streak' }, { status: 400 });

  // Eligibility, the reward amount and the double-claim guard all live in the
  // RPC. Nothing the client sends is trusted beyond WHICH streak — the amount
  // is never taken from the request.
  const { data, error } = await supabaseAdmin.rpc('claim_streak_reward', {
    p_user_id: user.id,
    p_streak_id: streakId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied) {
    return NextResponse.json({ error: row?.reason || 'Could not claim' }, { status: 400 });
  }

  return NextResponse.json({ rewardTngn: Number(row.reward_tngn || 0) });
}
