'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import Link from 'next/link';
import { TrendingUp, ArrowRight } from 'lucide-react';
import { MarketList } from '@/components/MarketList';
import { MarketsToolbar } from '@/components/MarketsToolbar';
import { ScrollFadeBackdrop } from '@/components/ScrollFadeBackdrop';
import { OpenMarketCard, type OpenMarketCardRow } from '@/components/OpenMarketCard';
import type { SportHub as SportHubConfig } from '@/lib/sportHubs';
import { cn } from '@/lib/utils';

/**
 * Generic sport hub — one component behind /basketball, /tennis, /esports and
 * /fight. Everything specific to a sport lives in lib/sportHubs.ts, so a new
 * hub is a config entry plus a three-line page, not a copy of this file.
 *
 * Structurally the same as FootballHub (competition tabs above the shared
 * search/filter toolbar, competition in ?competition=) — that consistency is
 * the point. A viewer who has used /football should not have to relearn
 * anything here. What changes per sport is the backdrop art and accent
 * colour, which is enough to make each hub feel like its own place.
 *
 * Football keeps its own component rather than folding into this one: it
 * carries twelve leagues with logos and per-league landing pages, and
 * flattening that into the generic shape would lose things it actually uses.
 */
export function SportHub({ hub, tradingMarkets = [] }: {
  hub: SportHubConfig;
  /** Trading (Open Markets) rows tagged event_tag = hub.sport. Fetched
      server-side by the page (see lib/sportHubData.ts) rather than here —
      SportHub stays a client component so the competition-tab URL state
      keeps working the way it always has, and one server fetch beats every
      one of the four hubs re-implementing its own loading state for this. */
  tradingMarkets?: OpenMarketCardRow[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedId = searchParams.get('competition') || 'all';
  const competitions = hub.competitions ?? [];
  const selected = competitions.find(c => c.id === selectedId) ?? null;

  const setCompetition = useCallback((id: string) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    if (id === 'all') next.delete('competition');
    else next.set('competition', id);
    router.push(`/${hub.id}?${next.toString()}`);
  }, [searchParams, router, hub.id]);

  return (
    <>
      <ScrollFadeBackdrop
        gradient={hub.gradient}
        imageUrl={hub.imageUrl}
        alt=""
      />

      {/* z-10 is load-bearing, not decoration: the backdrop is a fixed z-0
          layer, and non-positioned in-flow content paints BELOW that. Content
          has to be positioned and above it or the art covers the page. */}
      <div className="relative z-10 flex-1 min-w-0 px-3 py-4 md:p-6 space-y-4 md:space-y-5">
        <div className="flex items-baseline gap-2">
          <h1 className={cn('text-2xl md:text-3xl font-bold tracking-tight')}>{hub.label}</h1>
          <span className="text-sm text-muted-foreground">{hub.tagline}</span>
        </div>

        {/* Competition tabs, only when the sport actually has them — a lone
            "All" pill is chrome that does nothing, so hubs without
            competitions (Boxing & MMA) simply don't render this row. */}
        {competitions.length > 0 && (
          <div className="-mx-3 md:mx-0 overflow-x-auto no-scrollbar">
            <div className="flex gap-2 px-3 md:px-0 min-w-max">
              <CompetitionTab
                label="All"
                accentClass={hub.accentClass}
                isActive={selectedId === 'all'}
                onClick={() => setCompetition('all')}
              />
              {competitions.map(c => (
                <CompetitionTab
                  key={c.id}
                  label={c.label}
                  accentClass={hub.accentClass}
                  isActive={selectedId === c.id}
                  onClick={() => setCompetition(c.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Trading section, own header, never mixed into the locked-odds
            list below — a tradeable share and a fixed bet behave
            differently, and blurring that in one feed would mislead, not
            simplify. Mirrors the BBN hub's dual-section layout exactly. */}
        {tradingMarkets.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className={cn('w-4 h-4', hub.accentClass)} />
                <h2 className="text-sm font-semibold">Trading</h2>
              </div>
              <Link href="/open" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                All trading markets <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-1">
              Prices move as the house shifts. Buy a side and sell any time — you don&rsquo;t have to wait for the result.
            </p>
            <div className="space-y-3">
              {tradingMarkets.map(m => (
                <OpenMarketCard key={m.id} market={m} hideCategory />
              ))}
            </div>
          </section>
        )}

        {tradingMarkets.length > 0 && (
          <div className="flex items-center gap-2 pt-2">
            <h2 className="text-sm font-semibold">Predict &amp; hold</h2>
          </div>
        )}

        <MarketsToolbar />

        <MarketList
          leagueCode={selected?.code}
          sport={selected ? undefined : hub.sport}
        />
      </div>
    </>
  );
}

function CompetitionTab({ label, isActive, accentClass, onClick }: {
  label: string; isActive: boolean; accentClass: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap',
        isActive
          ? cn('bg-white/10 border-current', accentClass)
          : 'bg-muted/20 border-border/40 text-muted-foreground hover:text-foreground hover:border-border'
      )}
    >
      {label}
    </button>
  );
}
