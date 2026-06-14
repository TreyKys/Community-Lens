import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// In-memory cache for chart responses. The aggregation here scans every
// active bet on the market on every call — viral pages (/event/900 saw
// 273 hits in 24h) were running this hundreds of times against Nano
// Supabase IO. 30s of staleness is invisible on a pool chart, so we
// memoise per (marketId, mode) and serve repeats from process memory.
//
// Cache is per-serverless-instance: bursts to the same instance get
// coalesced; cold instances still hit the DB once. Bounded by a soft
// cap so a flood of distinct marketIds can't leak memory.
const CHART_CACHE_TTL_MS = 30_000;
const CHART_CACHE_MAX = 200;
const chartCache = new Map<string, { at: number; payload: any }>();

function getCachedChart(key: string): any | null {
  const hit = chartCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CHART_CACHE_TTL_MS) {
    chartCache.delete(key);
    return null;
  }
  return hit.payload;
}

function setCachedChart(key: string, payload: any): void {
  chartCache.set(key, { at: Date.now(), payload });
  if (chartCache.size > CHART_CACHE_MAX) {
    // Drop the oldest entry — sufficient for a soft bound; no need for LRU.
    const oldestKey = chartCache.keys().next().value;
    if (oldestKey) chartCache.delete(oldestKey);
  }
}

// GET /api/markets/chart?marketId=X&mode=distribution|snapshots
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get('marketId');
    const mode = searchParams.get('mode') || 'distribution';

    if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });

    const cacheKey = `${marketId}|${mode}`;
    const cached = getCachedChart(cacheKey);
    if (cached) return NextResponse.json(cached, { headers: { 'X-Cache': 'HIT' } });

    if (mode === 'distribution') {
      // Real bet distribution from user_bets
      const { data: market } = await supabaseAdmin
        .from('markets')
        .select('options, total_pool')
        .eq('id', marketId)
        .single();

      if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

      const options = market.options as string[];

      const { data: bets } = await supabaseAdmin
        .from('user_bets')
        .select('outcome_index, net_stake_tngn, placed_at')
        .eq('market_id', marketId)
        .eq('status', 'active');

      // Build per-option totals
      const optionTotals: number[] = options.map(() => 0);
      const timeline: { time: string; [key: string]: number | string }[] = [];

      // Group bets by hour for timeline
      const hourMap: Record<string, number[]> = {};
      for (const bet of bets || []) {
        const hour = new Date(bet.placed_at).toISOString().slice(0, 13) + ':00';
        if (!hourMap[hour]) hourMap[hour] = options.map(() => 0);
        hourMap[hour][bet.outcome_index] = (hourMap[hour][bet.outcome_index] || 0) + bet.net_stake_tngn;
        optionTotals[bet.outcome_index] += bet.net_stake_tngn;
      }

      // Build cumulative timeline
      const hours = Object.keys(hourMap).sort();
      const running = options.map(() => 0);
      for (const hour of hours) {
        options.forEach((_, i) => { running[i] += hourMap[hour][i] || 0; });
        const entry: any = {
          time: new Date(hour).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
        };
        options.forEach((opt, i) => { entry[opt] = Math.round(running[i]); });
        timeline.push(entry);
      }

      const totalPool = optionTotals.reduce((s, v) => s + v, 0);
      const distribution = options.map((opt, i) => ({
        option: opt,
        amount: optionTotals[i],
        percentage: totalPool > 0 ? Math.round((optionTotals[i] / totalPool) * 100) : 0,
      }));

      const payload = { mode: 'distribution', timeline, distribution, options, totalPool };
      setCachedChart(cacheKey, payload);
      return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } });
    }

    // mode === 'snapshots' — from market_snapshots table (historical volume)
    const { data: snapshots } = await supabaseAdmin
      .from('market_snapshots')
      .select('total_pool, created_at')
      .eq('market_id', marketId)
      .order('created_at', { ascending: true })
      .limit(48);

    const timeline = (snapshots || []).map(s => ({
      time: new Date(s.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }),
      volume: s.total_pool,
    }));

    const payload = { mode: 'snapshots', timeline };
    setCachedChart(cacheKey, payload);
    return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
