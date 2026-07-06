import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WINDOWS = ['daily', 'weekly', 'alltime'] as const;
type WindowKey = typeof WINDOWS[number];

function isWindowKey(w: string): w is WindowKey {
  return (WINDOWS as readonly string[]).includes(w);
}

// Window starts in WAT (Africa/Lagos = UTC+1, no DST) — same math as
// /api/leaderboard and /api/admin/leaderboard.
function windowStarts() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  const y = wat.getUTCFullYear(), m = wat.getUTCMonth(), d = wat.getUTCDate();
  const dayStartUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - 60 * 60 * 1000);
  const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const weekStartUtc = new Date(Date.UTC(y, m, d - daysSinceMonday, 0, 0, 0) - 60 * 60 * 1000);
  return { dayStartUtc, weekStartUtc };
}

function sinceFor(window: WindowKey, dayStartUtc: Date, weekStartUtc: Date): string | null {
  if (window === 'daily') return dayStartUtc.toISOString();
  if (window === 'weekly') return weekStartUtc.toISOString();
  return null; // alltime
}

async function publishWindow(window: WindowKey) {
  const { dayStartUtc, weekStartUtc } = windowStarts();
  const since = sinceFor(window, dayStartUtc, weekStartUtc);

  const { data, error } = await supabaseAdmin.rpc('leaderboard_points', {
    p_since: since,
    p_limit: 100,
  });
  if (error) throw new Error(error.message);

  // Same shape as the public route's rows — volume is deliberately
  // dropped here too, since this is exactly what gets served publicly.
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

  const publishedAt = new Date().toISOString();
  const { error: upsertError } = await supabaseAdmin.from('leaderboard_snapshot').upsert({
    window,
    since,
    rows,
    published_at: publishedAt,
    published_by: 'admin',
  });
  if (upsertError) throw new Error(upsertError.message);

  return { window, since, publishedAt, count: rows.length, rows };
}

// POST /api/admin/leaderboard/publish  { window?: 'daily'|'weekly'|'alltime' }
// Publishes the live standings to the public board. Omit `window` to
// publish all three at once — this is the button admins hit "at will"
// to push a fresh board; the public route never recomputes on its own.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const requested = String(body?.window || '').toLowerCase();
    const targets: WindowKey[] = isWindowKey(requested) ? [requested] : [...WINDOWS];

    const results = await Promise.all(targets.map(publishWindow));
    return NextResponse.json({ published: results });
  } catch (e: any) {
    console.error('leaderboard publish error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// GET /api/admin/leaderboard/publish — status only (last published_at
// per window), so the admin panel can show "last published" without
// triggering a new publish.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { data, error } = await supabaseAdmin
    .from('leaderboard_snapshot')
    .select('window, published_at, published_by')
    .in('window', [...WINDOWS]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ snapshots: data || [] });
}
