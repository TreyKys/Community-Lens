import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { createClient } from '@supabase/supabase-js';
import { getLeague, LEAGUE_IDS } from '@/lib/leagues';
import { LeagueHero } from '@/components/LeagueHero';
import { MarketList } from '@/components/MarketList';

export const dynamic = 'force-dynamic';

async function getLeagueCounts(code: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { active: 0, upcoming: 0 };

  const supabase = createClient(url, key);
  const now = new Date().toISOString();
  const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [activeRes, upcomingRes] = await Promise.all([
    supabase
      .from('markets')
      .select('id', { count: 'exact', head: true })
      .eq('category', 'sports')
      .eq('status', 'open')
      .ilike('question', `%${code}%`)
      .is('parent_market_id', null),
    supabase
      .from('markets')
      .select('id', { count: 'exact', head: true })
      .eq('category', 'sports')
      .eq('status', 'open')
      .ilike('question', `%${code}%`)
      .gte('closes_at', now)
      .lte('closes_at', in7d)
      .is('parent_market_id', null),
  ]);

  return { active: activeRes.count ?? 0, upcoming: upcomingRes.count ?? 0 };
}

export async function generateStaticParams() {
  return LEAGUE_IDS.map((id) => ({ id }));
}

export default async function LeaguePage({ params }: { params: { id: string } }) {
  const league = getLeague(params.id);
  if (!league) notFound();

  const counts = await getLeagueCounts(league.code);

  return (
    <div className="p-4 md:p-6 pb-24 md:pb-6">
      <LeagueHero league={league} activeCount={counts.active} upcomingCount={counts.upcoming} />
      <Suspense
        fallback={
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-36 bg-muted/30 rounded-xl animate-pulse" />
            ))}
          </div>
        }
      >
        <MarketList leagueCode={league.code} />
      </Suspense>
    </div>
  );
}
