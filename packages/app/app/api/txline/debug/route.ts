import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/oracle';
import { scoresHistorical, scoresSnapshot, rd } from '@/lib/txline/client';
import { findFinalRecord, readOutcome } from '@/lib/txline/settlement';

export const dynamic = 'force-dynamic';

// Cron secret or admin bearer — same pattern as the other /api/txline routes.
function authorized(request: Request): boolean {
  const cron = request.headers.get('x-cron-secret');
  if (cron && cron === process.env.CRON_SECRET) return true;
  const auth = request.headers.get('authorization');
  if (auth && auth === `Bearer ${process.env.ADMIN_SECRET}`) return true;
  return false;
}

function summarize(label: string, ok: boolean, records: any[] | null, error?: string) {
  const final = records ? findFinalRecord(records) : null;
  return {
    source: label,
    ok,
    error,
    recordCount: records?.length ?? 0,
    finalRecordFound: Boolean(final),
    lastRecord: records && records.length > 0
      ? { action: rd.action(records[records.length - 1]), seq: rd.seq(records[records.length - 1]) }
      : null,
    outcome: final ? readOutcome(final) : null,
  };
}

/**
 * Diagnostic: shows exactly what TxLINE's historical + snapshot endpoints
 * return for a mapped market's fixture, without touching any market state.
 * GET /api/txline/debug?marketId=2515
 */
export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const marketId = searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId query param required' }, { status: 400 });

  const supabaseAdmin = getSupabaseAdmin();
  const { data: market, error } = await supabaseAdmin
    .from('markets')
    .select('id, question, txline_fixture_id, status, closes_at')
    .eq('id', marketId)
    .single();
  if (error || !market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (!market.txline_fixture_id) {
    return NextResponse.json({ error: 'Not a TxLINE-mapped market' }, { status: 400 });
  }

  const fixtureId = market.txline_fixture_id;
  let historical: ReturnType<typeof summarize> | null = null;
  let snapshot: ReturnType<typeof summarize> | null = null;

  try {
    const records = await scoresHistorical(fixtureId);
    historical = summarize('historical', true, records);
  } catch (err: any) {
    historical = summarize('historical', false, null, err?.message || String(err));
  }

  try {
    const records = await scoresSnapshot(fixtureId, Date.now());
    snapshot = summarize('snapshot', true, records as any[]);
  } catch (err: any) {
    snapshot = summarize('snapshot', false, null, err?.message || String(err));
  }

  return NextResponse.json({
    market: { id: market.id, question: market.question, status: market.status, closes_at: market.closes_at },
    fixtureId,
    historical,
    snapshot,
  });
}
