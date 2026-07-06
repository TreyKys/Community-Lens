import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Public leaderboard endpoint. Serves the most recently admin-published
// snapshot for the requested window — it no longer recomputes
// leaderboard_points() live. Admins see the live board via
// /api/admin/leaderboard and push a new snapshot at will via
// POST /api/admin/leaderboard/publish; until they do, this keeps
// returning whatever was last published (or nothing, if never published).
//
// Reads via service-role so anonymous visitors (e.g. share-card
// landing pages) can render the board without a sign-in.

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WINDOWS = ['daily', 'weekly', 'alltime'] as const;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const window = (searchParams.get('window') || 'weekly').toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 50));

    if (!(WINDOWS as readonly string[]).includes(window)) {
      return NextResponse.json({ error: 'Invalid window' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('leaderboard_snapshot')
      .select('since, rows, published_at')
      .eq('window', window)
      .maybeSingle();

    if (error) {
      console.error('leaderboard snapshot read failed:', error);
      return NextResponse.json({ error: 'Could not load leaderboard' }, { status: 500 });
    }

    const rows = ((data?.rows as any[]) || []).slice(0, limit);

    return NextResponse.json(
      {
        window,
        since: data?.since ?? null,
        publishedAt: data?.published_at ?? null,
        count: rows.length,
        rows,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (e: any) {
    console.error('public leaderboard error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
