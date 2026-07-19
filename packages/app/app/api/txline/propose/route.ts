import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/oracle';
import { proposeResolutionForMarket } from '@/lib/txline/settlement';
import { isTxlineConfigured } from '@/lib/txline/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Cron secret or admin bearer.
function authorized(request: Request): boolean {
  const cron = request.headers.get('x-cron-secret');
  if (cron && cron === process.env.CRON_SECRET) return true;
  const auth = request.headers.get('authorization');
  if (auth && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  return false;
}

/**
 * Stage proof-backed resolution proposals for TxLINE-mapped markets.
 * Body: { marketId? } — one market, or omit to scan all unresolved mapped
 * markets whose kickoff has passed. Never pays out; only attaches proof and
 * locks the market for admin approval.
 */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isTxlineConfigured()) {
    return NextResponse.json({ error: 'TXLINE_API_TOKEN not set' }, { status: 503 });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const body = await request.json().catch(() => ({}));
  const marketId = body?.marketId;

  let markets: Array<{ id: number; txline_fixture_id: number | null; status: string }> = [];

  if (marketId) {
    const { data, error } = await supabaseAdmin
      .from('markets')
      .select('id, txline_fixture_id, status')
      .eq('id', marketId)
      .single();
    if (error || !data) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    markets = [data];
  } else {
    const { data, error } = await supabaseAdmin
      .from('markets')
      .select('id, txline_fixture_id, status, closes_at')
      .not('txline_fixture_id', 'is', null)
      .in('status', ['open', 'locked'])
      .lte('closes_at', new Date().toISOString())
      .order('closes_at', { ascending: true })
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    markets = data || [];
  }

  const results = [];
  for (const m of markets) {
    results.push(await proposeResolutionForMarket(m));
  }

  const proposed = results.filter((r) => r.status === 'proposed').length;
  return NextResponse.json({ ok: true, scanned: markets.length, proposed, results });
}
