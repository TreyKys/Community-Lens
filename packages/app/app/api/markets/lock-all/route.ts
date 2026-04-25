import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: markets } = await supabaseAdmin
      .from('markets')
      .select('id, title')
      .eq('status', 'open')
      .lt('closes_at', new Date().toISOString());

    if (!markets?.length) {
      return NextResponse.json({ locked: 0 }, { status: 200 });
    }

    const results = [];
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    for (const m of markets) {
      try {
        const res = await fetch(`${baseUrl}/api/markets/lock`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': process.env.CRON_SECRET!
          },
          body: JSON.stringify({ marketId: m.id }),
        });
        const d = await res.json();
        results.push(res.ok ? { marketId: m.id, success: true } : { marketId: m.id, success: false, error: d.error });
      } catch (err: any) {
         results.push({ marketId: m.id, success: false, error: err.message });
      }
    }

    return NextResponse.json({ locked: markets.length, results }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
