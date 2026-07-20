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

// Run an array of async jobs with bounded concurrency. Each fixture involves
// 1-3 chained TxLINE round-trips (historical/snapshot + proof), so scanning
// a large batch sequentially blows past typical serverless function timeouts
// (Netlify's default is 10-26s regardless of the maxDuration hint below,
// which is a Vercel-style config it doesn't honor). Bounded concurrency keeps
// wall-clock time down without hammering TxLINE with 100 simultaneous calls.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Stage proof-backed resolution proposals for TxLINE-mapped markets.
 * Body: { marketId? } — one market, or omit to scan a batch of unresolved
 * mapped markets whose kickoff has passed. Query params ?limit= (default 8)
 * and ?concurrency= (default 4) bound how much work one call does — call it
 * repeatedly (or point a cron at it) to work through a large backlog without
 * timing out. Never pays out; only attaches proof and locks the market for
 * admin approval.
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

  const { searchParams } = new URL(request.url);
  const limit = Math.max(1, Math.min(25, Number(searchParams.get('limit')) || 8));
  const concurrency = Math.max(1, Math.min(8, Number(searchParams.get('concurrency')) || 4));

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
      // Most-recent-kickoff first: TxLINE's historical scores endpoint only
      // covers roughly the last two weeks, so the oldest group-stage matches
      // are the LEAST likely to have a retrievable game_finalised record.
      // Scanning newest-first finds the demo-able (recent) results first.
      .order('closes_at', { ascending: false })
      .limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    markets = data || [];
  }

  const results = await mapWithConcurrency(markets, concurrency, proposeResolutionForMarket);

  const proposed = results.filter((r) => r.status === 'proposed').length;
  return NextResponse.json({ ok: true, scanned: markets.length, proposed, results });
}
