import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Cron (every 5 min, mirrors /api/markets/lock-all): flips markets whose
// scheduled opens_at has arrived from 'scheduled' to 'open', stamping
// published_at so they surface at the top of New/Trending immediately.
// Unlike locking, opening has no side effects to snapshot — it's a
// plain bulk status flip, so one UPDATE covers every due market instead
// of looping per-row.
export async function POST(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const nowIso = new Date().toISOString();
    const { data: opened, error } = await supabaseAdmin
      .from('markets')
      .update({ status: 'open', published_at: nowIso })
      .eq('status', 'scheduled')
      .lte('opens_at', nowIso)
      .select('id, question');

    if (error) {
      console.error('open-scheduled failed:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ opened: (opened || []).length, markets: opened || [] }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
