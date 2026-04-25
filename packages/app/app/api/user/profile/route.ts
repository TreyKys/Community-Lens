import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function getAuthUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// GET /api/user/profile — full profile + stats
export async function GET(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });

    // Compute ego metrics
    const { data: betStats } = await supabaseAdmin
      .from('user_bets')
      .select('status, stake_tngn, payout_tngn, placed_at')
      .eq('user_id', user.id)
      .in('status', ['won', 'lost', 'active', 'refunded']);

    const bets = betStats || [];
    const resolved = bets.filter(b => b.status === 'won' || b.status === 'lost');
    const won = bets.filter(b => b.status === 'won');
    const totalVolume = bets.reduce((s, b) => s + (b.stake_tngn || 0), 0);
    const totalPayout = won.reduce((s, b) => s + (b.payout_tngn || 0), 0);
    const winRate = resolved.length > 0 ? (won.length / resolved.length) * 100 : 0;
    const activeBets = bets.filter(b => b.status === 'active').length;

    // Compute 30-day heatmap data
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentBets } = await supabaseAdmin
      .from('user_bets')
      .select('placed_at, status, stake_tngn, payout_tngn')
      .eq('user_id', user.id)
      .gte('placed_at', thirtyDaysAgo.toISOString())
      .in('status', ['won', 'lost', 'active']);

    // Build day-by-day map
    const heatmap: Record<string, { pnl: number; count: number }> = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      heatmap[key] = { pnl: 0, count: 0 };
    }

    for (const bet of recentBets || []) {
      const key = bet.placed_at?.split('T')[0];
      if (key && heatmap[key] !== undefined) {
        heatmap[key].count += 1;
        if (bet.status === 'won') {
          heatmap[key].pnl += (bet.payout_tngn || 0) - (bet.stake_tngn || 0);
        } else if (bet.status === 'lost') {
          heatmap[key].pnl -= (bet.stake_tngn || 0);
        }
      }
    }

    return NextResponse.json({
      profile,
      stats: {
        winRate: Math.round(winRate * 10) / 10,
        totalVolume,
        totalPayout,
        activeBets,
        resolvedBets: resolved.length,
        wonBets: won.length,
      },
      heatmap,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH /api/user/profile — update username, avatar, display name
export async function PATCH(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { username, avatar_id, first_name, dob } = body;

    // Validate username uniqueness if being set
    if (username) {
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        return NextResponse.json({
          error: 'Username must be 3-20 characters, letters, numbers, underscores only'
        }, { status: 400 });
      }

      const { data: existing } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('username', username)
        .neq('id', user.id)
        .single();

      if (existing) {
        return NextResponse.json({ error: 'Username already taken' }, { status: 409 });
      }
    }

    const updatePayload: any = {};
    if (username !== undefined) updatePayload.username = username;
    if (avatar_id !== undefined) updatePayload.avatar_id = avatar_id;
    if (first_name !== undefined) updatePayload.first_name = first_name;
    if (dob !== undefined) updatePayload.dob = dob;
    updatePayload.profile_complete = true;

    const { error } = await supabaseAdmin
      .from('users')
      .update(updatePayload)
      .eq('id', user.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
