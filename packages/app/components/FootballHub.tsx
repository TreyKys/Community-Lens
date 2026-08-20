'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { LEAGUES, LEAGUE_IDS, getLeague } from '@/lib/leagues';
import { FOOTBALL_HUB_ART } from '@/lib/sportHubs';
import { MarketList } from '@/components/MarketList';
import { MarketsToolbar } from '@/components/MarketsToolbar';
import { ScrollFadeBackdrop } from '@/components/ScrollFadeBackdrop';
import { cn } from '@/lib/utils';

/**
 * Football hub — replaces the old per-league pages. Horizontal league
 * tabs (with an "All" pill that defaults selected) sit above the existing
 * search/filter toolbar, which reads the same ?q ?sort ?status params as
 * the markets page. League selection is in ?league=<id>.
 */
export function FootballHub() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedId = searchParams.get('league') || 'all';
  const selectedLeague = selectedId === 'all' ? null : getLeague(selectedId);

  const setLeague = useCallback((id: string) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    if (id === 'all') next.delete('league');
    else next.set('league', id);
    router.push(`/football?${next.toString()}`);
  }, [searchParams, router]);

  return (
    <>
      <ScrollFadeBackdrop
        gradient={FOOTBALL_HUB_ART.gradient}
        imageUrl={FOOTBALL_HUB_ART.imageUrl}
      />

      {/* z-10 is load-bearing: the backdrop is a fixed z-0 layer, and
          non-positioned in-flow content paints BELOW that, so the art would
          cover the page without this. */}
      <div className="relative z-10 flex-1 min-w-0 px-3 py-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex items-baseline gap-2">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Football</h1>
        <span className="text-sm text-muted-foreground">Every league. One feed.</span>
      </div>

      {/* Horizontal league tabs — scrollable on mobile, no wrap. */}
      <div className="-mx-3 md:mx-0 overflow-x-auto no-scrollbar">
        <div className="flex gap-2 px-3 md:px-0 min-w-max">
          <LeagueTab
            label="All"
            isActive={selectedId === 'all'}
            onClick={() => setLeague('all')}
          />
          {LEAGUE_IDS.map(id => {
            const lg = LEAGUES[id];
            return (
              <LeagueTab
                key={id}
                label={lg.shortLabel}
                isActive={selectedId === id}
                onClick={() => setLeague(id)}
              />
            );
          })}
        </div>
      </div>

      <MarketsToolbar />

      <MarketList
        leagueCode={selectedLeague?.code}
        sport={selectedLeague ? undefined : 'football'}
      />
      </div>
    </>
  );
}

function LeagueTab({ label, isActive, onClick }: { label: string; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap',
        isActive
          ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
          : 'bg-muted/20 border-border/40 text-muted-foreground hover:text-foreground hover:border-border'
      )}
    >
      {label}
    </button>
  );
}
