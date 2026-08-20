import { createClient } from '@supabase/supabase-js';
import { Suspense } from 'react';
import { BBNHub } from '@/components/BBNHub';
import { BBNComingSoon } from '@/components/BBNComingSoon';
import { BBN_SPORT, BBN_TAG_IDS, BBN_TAGS } from '@/lib/bbnTags';
import { getDisplayPool } from '@/lib/displayPool';
import { pricesFromQ, volumeFromFees, type OpenMarketListRow } from '@/lib/openMarketTypes';
import type { OpenMarketCardRow } from '@/components/OpenMarketCard';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Big Brother Naija · Opinions.ng',
  description: 'Predict every eviction, every Head of House, every ship — real money on the house.',
};

// Locked Odds and the LMSR trading engine are two STAKING MODES, not two
// products — a market can be created on either one. This page is where that
// actually shows up for BBN: it pulls from BOTH the `markets` table (locked
// odds, tagged sport='bbn') and `open_markets` (trading, tagged
// event_tag='bbn') and renders both, clearly labelled, on one page.
//
// They're kept as two sections rather than interleaved into one list. That's
// deliberate, not a shortcut: a locked bet and a tradeable share are
// different things to a user — one is a fixed price you hold to the end, the
// other moves and can be sold early — and blurring that distinction in a
// single mixed feed would be the misleading move, not the polished one.
async function getBbnState() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const empty = {
    openCount: 0, upcomingCount: 0, poolTngn: 0, tagCounts: {} as Record<string, number>,
    tradingMarkets: [] as OpenMarketCardRow[], tradingOpenCount: 0, tradingVolumeTngn: 0,
  };
  if (!url || !key) return empty;

  const supabase = createClient(url, key);
  const now = new Date().toISOString();
  const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const lockedBase = () => supabase
    .from('markets')
    .select('id', { count: 'exact', head: true })
    .eq('category', 'entertainment')
    .eq('sport', BBN_SPORT)
    .is('parent_market_id', null);

  const [lockedOpenRes, lockedUpcomingRes, poolRes, tradingRes, ...tagResults] = await Promise.all([
    lockedBase().eq('status', 'open'),
    lockedBase().eq('status', 'open').gte('closes_at', now).lte('closes_at', in7d),
    supabase
      .from('markets')
      .select('total_pool')
      .eq('category', 'entertainment')
      .eq('sport', BBN_SPORT)
      .eq('status', 'open')
      .is('parent_market_id', null),
    // Trading-engine side: same visibility rule as /api/open-markets — never
    // surface pending_review/rejected, an unapproved market must not be
    // discoverable just because it happens to be tagged for this hub.
    supabase
      .from('open_markets')
      .select('id, question, description, category, outcomes, q, b, status, ' +
              'horizon_at, trading_closes_at, fees_collected, created_at, opened_at, event_tag')
      .eq('event_tag', BBN_SPORT)
      .in('status', ['open', 'horizon_window', 'closed', 'pending_payout', 'resolved'])
      .order('opened_at', { ascending: false, nullsFirst: false })
      .limit(20)
      .returns<OpenMarketListRow[]>(),
    ...BBN_TAG_IDS.map(id => lockedBase().eq('status', 'open').eq('league_code', BBN_TAGS[id].code)),
  ]);

  const poolTngn = (poolRes.data || []).reduce((sum, m: any) => sum + Number(m.total_pool || 0), 0);
  const tagCounts: Record<string, number> = {};
  BBN_TAG_IDS.forEach((id, i) => { tagCounts[id] = tagResults[i].count ?? 0; });

  const tradingRows = tradingRes.data || [];
  const tradingMarkets: OpenMarketCardRow[] = tradingRows.map(m => ({
    id: m.id,
    question: m.question,
    category: m.category,
    outcomes: m.outcomes,
    prices: pricesFromQ(m.q, m.b),
    status: m.status,
    volumeTngn: volumeFromFees(m.fees_collected),
    horizonAt: m.horizon_at,
  }));
  const tradingOpenCount = tradingRows.filter(m => m.status === 'open' || m.status === 'horizon_window').length;
  const tradingVolumeTngn = tradingRows.reduce((sum, m) => sum + volumeFromFees(m.fees_collected), 0);

  return {
    openCount: lockedOpenRes.count ?? 0,
    upcomingCount: lockedUpcomingRes.count ?? 0,
    poolTngn: getDisplayPool(poolTngn),
    tagCounts,
    tradingMarkets,
    tradingOpenCount,
    tradingVolumeTngn,
  };
}

export default async function BbnPage() {
  const state = await getBbnState();

  const nothingLive = state.openCount === 0 && state.upcomingCount === 0
    && state.tradingMarkets.length === 0;

  // No live season right now, on EITHER engine — show the event framing
  // without pretending there's a feed to browse. A hub that renders "LIVE"
  // chrome over an empty list reads as broken; one that says "off air"
  // reads as honest.
  if (nothingLive) {
    return (
      <div className="p-4 md:p-6 pb-24 md:pb-6">
        <BBNComingSoon />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col min-h-screen pb-20 md:pb-0">
      <Suspense fallback={<div className="p-4 space-y-4">
        <div className="h-48 rounded-2xl shimmer" />
        <div className="h-10 rounded-lg shimmer" />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-36 rounded-xl shimmer" />
          ))}
        </div>
      </div>}>
        <BBNHub
          openCount={state.openCount}
          upcomingCount={state.upcomingCount}
          poolTngn={state.poolTngn}
          tagCounts={state.tagCounts}
          tradingMarkets={state.tradingMarkets}
          tradingOpenCount={state.tradingOpenCount}
          tradingVolumeTngn={state.tradingVolumeTngn}
        />
      </Suspense>
    </div>
  );
}
