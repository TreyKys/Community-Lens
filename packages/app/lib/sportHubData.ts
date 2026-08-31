// Server-side data for a sport hub's trading (Open Markets) section.
//
// Extracted out of app/(bbn)/page.tsx rather than left there, because the
// four generic hubs (basketball/tennis/esports/fight) need the identical
// query and BBN already proved the shape works. Duplicating it into four
// page.tsx files would mean the visibility rule below drifting out of sync
// the first time someone edits one copy and not the others.
//
// event_tag = hub.sport is the join key. It is the same string SportHub
// already uses for the locked-odds side (MarketList's `sport` prop), so
// tagging a trading market for "basketball" makes it show up in exactly the
// one place a market tagged "basketball" is supposed to show up — one
// vocabulary, not two.
import { createClient } from '@supabase/supabase-js';
import { pricesFromQ, volumeFromFees, type OpenMarketListRow } from '@/lib/openMarketTypes';
import type { OpenMarketCardRow } from '@/components/OpenMarketCard';
import type { SportHub } from '@/lib/sportHubs';

export type SportHubTradingState = {
  tradingMarkets: OpenMarketCardRow[];
  tradingOpenCount: number;
  tradingVolumeTngn: number;
};

const EMPTY: SportHubTradingState = { tradingMarkets: [], tradingOpenCount: 0, tradingVolumeTngn: 0 };

export async function getSportHubTradingState(hub: SportHub): Promise<SportHubTradingState> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return EMPTY;

  const supabase = createClient(url, key);

  const { data } = await supabase
    .from('open_markets')
    .select('id, question, description, category, outcomes, q, b, status, ' +
            'horizon_at, trading_closes_at, fees_collected, created_at, opened_at, event_tag')
    // Same visibility rule as /api/open-markets and the BBN hub: a market
    // still in pending_review or bounced back for revision must not be
    // discoverable here just because it happens to be tagged for this hub.
    .eq('event_tag', hub.sport)
    .in('status', ['open', 'horizon_window', 'closed', 'pending_payout', 'resolved'])
    .order('opened_at', { ascending: false, nullsFirst: false })
    .limit(20)
    .returns<OpenMarketListRow[]>();

  const rows = data || [];
  const tradingMarkets: OpenMarketCardRow[] = rows.map(m => ({
    id: m.id,
    question: m.question,
    category: m.category,
    outcomes: m.outcomes,
    prices: pricesFromQ(m.q, m.b),
    status: m.status,
    volumeTngn: volumeFromFees(m.fees_collected),
    horizonAt: m.horizon_at,
  }));

  return {
    tradingMarkets,
    tradingOpenCount: rows.filter(m => m.status === 'open' || m.status === 'horizon_window').length,
    tradingVolumeTngn: rows.reduce((sum, m) => sum + volumeFromFees(m.fees_collected), 0),
  };
}
