import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { runMechanicScan } from '@/lib/mechanic/scans';

// Read-only detection engine. Runs every scan in parallel and returns
// categorized findings. No fixes, no mutations — this is the "what's
// broken right now" call that /ops (and the heartbeat cron) both use.
//
// Auth: admin cookie / bearer (same gate as /admin). The heartbeat
// cron uses the CRON_SECRET header — accepted below.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  const isValidCron = cronSecret === process.env.CRON_SECRET;
  const isValidAdmin = isAdminRequest(request);
  if (!isValidCron && !isValidAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const scopeParam = url.searchParams.get('scope');
    const scope = scopeParam ? scopeParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const result = await runMechanicScan(supabaseAdmin, { scope });

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      },
    });
  } catch (e: any) {
    console.error('mechanic/scan crashed:', e);
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
