import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Public leaderboard endpoint. Mirrors /api/admin/leaderboard but
// drops the admin auth + the volume column — volume is the user's
// lifetime ₦ staked, which is private. Everything else is vanity
// data already exposed via the share card (username, accuracy %,
// resolved count).
//
// Reads via service-role so anonymous visitors (e.g. share-card
// landing pages) can render the same board without a sign-in. The
// underlying RPC is granted to authenticated only, so service-role
// is the right transport — the RLS lockdown stays intact.
//
// Cache: 60s edge cache. The Monday-flip is the only moment freshness
// really matters and that's never seconds-critical.

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function windowStarts() {
  const now = new Date();
  // Africa/Lagos = UTC+1, no DST. Shift to the WAT wall clock so date
  // math reflects Lagos midnight, then convert back to UTC for filters.
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  const y = wat.getUTCFullYear(), m = wat.getUTCMonth(), d = wat.getUTCDate();
  const dayStartUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 60 * 60 * 1000);
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const weekStartUtc = new Date(Date.UTC(y, m, d - daysSinceMonday, 0, 0, 0) - 60 * 60 * 1000);
  return { dayStartUtc, weekStartUtc };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const window = (searchParams.get('window') || 'weekly').toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 50));

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
      console.error('public leaderboard_points failed:', error);
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
      };
    });

    return NextResponse.json(
      { window, since, count: rows.length, rows },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (e: any) {
    console.error('public leaderboard error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
