import { NextResponse } from 'next/server';
import { syncWorldCupFixtures } from '@/lib/txline/sync';
import { isTxlineConfigured } from '@/lib/txline/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Authorized by either the cron secret (x-cron-secret) or an admin bearer,
// mirroring the existing cron + admin routes.
function authorized(request: Request): boolean {
  const cron = request.headers.get('x-cron-secret');
  if (cron && cron === process.env.CRON_SECRET) return true;
  const auth = request.headers.get('authorization');
  if (auth && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  return false;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isTxlineConfigured()) {
    return NextResponse.json(
      { error: 'TXLINE_API_TOKEN not set — run the subscribe+activate bootstrap first.' },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Number(limitParam)) : undefined;

  try {
    const result = await syncWorldCupFixtures(limit);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
