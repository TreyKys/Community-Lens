import { createClient } from '@supabase/supabase-js';
import { Suspense } from 'react';
import { BBNHub } from '@/components/BBNHub';
import { BBNComingSoon } from '@/components/BBNComingSoon';
import { BBN_SPORT, BBN_TAG_IDS, BBN_TAGS } from '@/lib/bbnTags';
import { getDisplayPool } from '@/lib/displayPool';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Big Brother Naija · Opinions.ng',
  description: 'Predict every eviction, every Head of House, every ship — real money on the house.',
};

// BBN markets are tagged category='entertainment', sport='bbn', with an
// optional league_code from BBN_TAGS for the market-type sub-filter. Same
// mechanism /football uses for leagues — see lib/bbnTags.ts.
async function getBbnState() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { openCount: 0, upcomingCount: 0, poolTngn: 0, tagCounts: {} as Record<string, number> };

  const supabase = createClient(url, key);
  const now = new Date().toISOString();
  const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const base = () => supabase
    .from('markets')
    .select('id', { count: 'exact', head: true })
    .eq('category', 'entertainment')
    .eq('sport', BBN_SPORT)
    .is('parent_market_id', null);

  const [openRes, upcomingRes, poolRes, ...tagResults] = await Promise.all([
    base().eq('status', 'open'),
    base().eq('status', 'open').gte('closes_at', now).lte('closes_at', in7d),
    supabase
      .from('markets')
      .select('total_pool')
      .eq('category', 'entertainment')
      .eq('sport', BBN_SPORT)
      .eq('status', 'open')
      .is('parent_market_id', null),
    ...BBN_TAG_IDS.map(id => base().eq('status', 'open').eq('league_code', BBN_TAGS[id].code)),
  ]);

  const poolTngn = (poolRes.data || []).reduce((sum, m: any) => sum + Number(m.total_pool || 0), 0);
  const tagCounts: Record<string, number> = {};
  BBN_TAG_IDS.forEach((id, i) => { tagCounts[id] = tagResults[i].count ?? 0; });

  return {
    openCount: openRes.count ?? 0,
    upcomingCount: upcomingRes.count ?? 0,
    poolTngn: getDisplayPool(poolTngn),
    tagCounts,
  };
}

export default async function BbnPage() {
  const state = await getBbnState();

  // No live season right now — show the event framing without pretending
  // there's a feed to browse. A hub that renders an empty list under a
  // "LIVE" badge reads as broken; one that says "off air" reads as honest.
  if (state.openCount === 0 && state.upcomingCount === 0) {
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
        />
      </Suspense>
    </div>
  );
}
