import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { pricesFromQ } from '@/lib/openMarketTypes';
import { getDisplayPool } from '@/lib/displayPool';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/markets/movers — what has actually moved in the last 24 hours.
//
// The markets list is a wall of static cards: a question, a percentage, a
// pool. Nothing on it changes while you look at it, and nothing tells you
// which of forty markets is worth your attention right now. This is the fix —
// the handful where the crowd genuinely changed its mind today.
//
// Spans BOTH engines, because "what's moving" is a question about the site,
// not about an implementation:
//
//   locked odds  -> share of the pool on the leading outcome, now vs 24h ago,
//                   recomputed from user_bets.placed_at
//   trading      -> LMSR price now vs the earliest price recorded after the
//                   cutoff, from open_trades.price_after
//
// COST. The naive version reads every bet on every open market. Instead this
// starts from the only markets that CAN have moved — the ones with activity
// inside the window — and bounds the follow-up to those. A market with no
// trades today has a 24h delta of exactly zero by definition, so skipping it
// costs no accuracy at all.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_MARKETS = 25;   // ceiling on the follow-up fetch

type Mover = {
  id: string;
  engine: 'locked' | 'trading';
  question: string;
  category: string | null;
  topOutcome: string;
  pricePct: number;        // 0..100, where it sits now
  deltaPct: number;        // signed points moved in the window
  poolTngn: number;
  traders: number;
  href: string;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') || 6), 12);
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();

  const movers: Mover[] = [];

  // ── Locked odds ────────────────────────────────────────────────────────
  try {
    // Step 1: which markets saw money today. Indexed on placed_at, and the
    // result set is the natural candidate list.
    const { data: recent } = await supabaseAdmin
      .from('user_bets')
      .select('market_id')
      .gte('placed_at', cutoff)
      .limit(4000);

    const counts = new Map<number, number>();
    for (const r of (recent || []) as any[]) {
      counts.set(r.market_id, (counts.get(r.market_id) || 0) + 1);
    }
    const activeIds = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ACTIVE_MARKETS)
      .map(([id]) => id);

    if (activeIds.length) {
      const [{ data: mkts }, { data: bets }] = await Promise.all([
        supabaseAdmin
          .from('markets')
          .select('id, question, options, category, total_pool, status')
          .in('id', activeIds)
          .eq('status', 'open')
          .is('parent_market_id', null),
        supabaseAdmin
          .from('user_bets')
          .select('market_id, outcome_index, net_stake_tngn, placed_at, user_id')
          .in('market_id', activeIds)
          .limit(20000),
      ]);

      const byMarket = new Map<number, any[]>();
      for (const b of (bets || []) as any[]) {
        if (!byMarket.has(b.market_id)) byMarket.set(b.market_id, []);
        byMarket.get(b.market_id)!.push(b);
      }

      for (const m of (mkts || []) as any[]) {
        const rows = byMarket.get(m.id) || [];
        if (rows.length === 0) continue;
        const options: string[] = Array.isArray(m.options) ? m.options : [];
        if (options.length === 0) continue;

        // Two distributions from one pass: everything, and everything that
        // was already there before the window opened.
        const now = new Array(options.length).fill(0);
        const then = new Array(options.length).fill(0);
        const traders = new Set<string>();
        for (const b of rows) {
          const i = Number(b.outcome_index);
          if (!(i >= 0 && i < options.length)) continue;
          const v = Number(b.net_stake_tngn || 0);
          now[i] += v;
          if (b.placed_at < cutoff) then[i] += v;
          if (b.user_id) traders.add(b.user_id);
        }

        const sumNow = now.reduce((a, b) => a + b, 0);
        const sumThen = then.reduce((a, b) => a + b, 0);
        if (sumNow <= 0) continue;

        const top = now.indexOf(Math.max(...now));
        const pctNow = (now[top] / sumNow) * 100;
        // A market with no prior money did not "move" — it STARTED. Reporting
        // a swing from an imaginary baseline would put every brand-new market
        // at the top of a rail that is supposed to mean "the crowd changed its
        // mind", so those are treated as zero movement rather than infinite.
        const pctThen = sumThen > 0 ? (then[top] / sumThen) * 100 : pctNow;

        movers.push({
          id: String(m.id),
          engine: 'locked',
          question: m.question,
          category: m.category ?? null,
          topOutcome: options[top],
          pricePct: pctNow,
          deltaPct: pctNow - pctThen,
          poolTngn: getDisplayPool(m.total_pool),
          traders: traders.size,
          href: `/markets?category=trending`,
        });
      }
    }
  } catch { /* one engine failing must not blank the whole rail */ }

  // ── Trading (Open Markets) ─────────────────────────────────────────────
  try {
    const { data: oms } = await supabaseAdmin
      .from('open_markets')
      .select('id, question, category, outcomes, q, b, fees_collected')
      .in('status', ['open', 'horizon_window'])
      .limit(MAX_ACTIVE_MARKETS);

    const ids = (oms || []).map((m: any) => m.id);
    if (ids.length) {
      const { data: trades } = await supabaseAdmin
        .from('open_trades')
        .select('market_id, outcome_idx, price_after, created_at, user_id')
        .in('market_id', ids)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(5000);

      // Earliest price inside the window, per market+outcome — the baseline
      // the current price is measured against.
      const firstIn = new Map<string, number>();
      const traders = new Map<string, Set<string>>();
      for (const t of (trades || []) as any[]) {
        const key = `${t.market_id}:${t.outcome_idx}`;
        if (!firstIn.has(key)) firstIn.set(key, Number(t.price_after));
        if (!traders.has(t.market_id)) traders.set(t.market_id, new Set());
        if (t.user_id) traders.get(t.market_id)!.add(t.user_id);
      }

      for (const m of (oms || []) as any[]) {
        const prices = pricesFromQ(m.q, m.b);
        const top = prices.indexOf(Math.max(...prices));
        const baseline = firstIn.get(`${m.id}:${top}`);
        if (baseline === undefined) continue;      // no trades today = not moving

        movers.push({
          id: m.id,
          engine: 'trading',
          question: m.question,
          category: m.category ?? null,
          topOutcome: m.outcomes?.[top] ?? '',
          pricePct: prices[top] * 100,
          deltaPct: (prices[top] - baseline) * 100,
          poolTngn: Math.round(Number(m.fees_collected || 0) / 0.015),
          traders: traders.get(m.id)?.size ?? 0,
          href: `/open/${m.id}`,
        });
      }
    }
  } catch { /* as above */ }

  // Biggest movers first, in either direction — a 12-point collapse is every
  // bit as interesting as a 12-point surge.
  const ranked = movers
    .filter(m => Math.abs(m.deltaPct) >= 1)   // below a point is noise, not news
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
    .slice(0, limit);

  return NextResponse.json({ movers: ranked }, {
    // Short cache: this is a "what's hot" rail, not a price feed. Ten seconds
    // keeps it lively while stopping a busy evening from running this
    // aggregation once per visitor.
    headers: { 'Cache-Control': 'public, max-age=10, stale-while-revalidate=30' },
  });
}
