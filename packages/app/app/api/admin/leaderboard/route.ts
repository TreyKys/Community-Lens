import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Window starts in WAT (Africa/Lagos = UTC+1, no DST), returned as UTC
// ISO strings for the points_log filter.
function windowStarts() {
  const now = new Date();
  // Shift to the WAT wall clock so date math reflects Lagos midnight.
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  const y = wat.getUTCFullYear(), m = wat.getUTCMonth(), d = wat.getUTCDate();

  // Today 00:00 WAT → subtract the +1h shift to get the real UTC instant.
  const dayStartUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 60 * 60 * 1000);

  // Monday 00:00 WAT. getUTCDay on the WAT clock: 0=Sun..6=Sat.
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const weekStartUtc = new Date(Date.UTC(y, m, d - daysSinceMonday, 0, 0, 0) - 60 * 60 * 1000);

  return { dayStartUtc, weekStartUtc };
}

// GET /api/admin/leaderboard?window=daily|weekly|alltime&limit=50
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const window = (searchParams.get('window') || 'weekly').toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 50));

    const { dayStartUtc, weekStartUtc } = windowStarts();
    let since: string | null = null;
    if (window === 'daily') since = dayStartUtc.toISOString();
    else if (window === 'weekly') since = weekStartUtc.toISOString();
    else since = null; // alltime

    const { data, error } = await supabaseAdmin.rpc('leaderboard_points', {
      p_since: since,
      p_limit: limit,
    });

    if (error) {
      console.error('leaderboard_points failed:', error);
      return NextResponse.json({ error: 'Could not load leaderboard' }, { status: 500 });
    }

    const rows = (data || []).map((r: any, i: number) => {
      const resolved = Number(r.resolved_bets || 0);
      const won = Number(r.won_bets || 0);
      return {
        rank: i + 1,
        userId: r.user_id,
        username: r.username || 'anon',
        avatarId: r.avatar_id ?? 0,
        points: Math.round(Number(r.points_window || 0)),
        accuracy: resolved > 0 ? Math.round((won / resolved) * 100) : null,
        resolvedBets: resolved,
        wonBets: won,
        volume: Math.round(Number(r.volume_tngn || 0)),
      };
    });

    return NextResponse.json({
      window,
      since,
      count: rows.length,
      rows,
    });
  } catch (e: any) {
    console.error('admin leaderboard error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
