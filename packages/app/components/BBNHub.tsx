'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import Link from 'next/link';
import { Eye, ChevronLeft, Trophy, DoorOpen, Crown, Heart, Zap, Flame, TrendingUp, ArrowRight } from 'lucide-react';
import { BBN_TAGS, BBN_TAG_IDS, BBN_SPORT, BBN_HUB_ART, getBbnTag } from '@/lib/bbnTags';
import { MarketList } from '@/components/MarketList';
import { MarketsToolbar } from '@/components/MarketsToolbar';
import { ScrollFadeBackdrop } from '@/components/ScrollFadeBackdrop';
import { OpenMarketCard, type OpenMarketCardRow } from '@/components/OpenMarketCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TAG_ICON: Record<string, typeof Trophy> = {
  winner: Trophy,
  eviction: DoorOpen,
  hoh: Crown,
  ship: Heart,
  twist: Zap,
};

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;

// Big Brother Naija hub — deliberately NOT a reskin of /football.
//
// Football is a schedule: fixtures, leagues, kickoff times — clean and
// functional is right for it. BBN is a live event people check obsessively
// during eviction week, so the hub leans into that: a stage-lit hero instead
// of a plain header, an "ON AIR" pulse instead of a static status pill, and
// market-type chips with icons instead of a flat text tab row. The colour
// language (fuchsia + amber) is not invented for this — it's the same accent
// PopularMarketsScroll already uses for category='entertainment' content, so
// this reads as "the entertainment section, turned up" rather than a new
// palette bolted onto the app.
export function BBNHub({ openCount, upcomingCount, poolTngn, tagCounts,
  tradingMarkets, tradingOpenCount, tradingVolumeTngn }: {
  openCount: number; upcomingCount: number; poolTngn: number;
  tagCounts: Record<string, number>;
  tradingMarkets: OpenMarketCardRow[];
  tradingOpenCount: number;
  tradingVolumeTngn: number;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedTagId = searchParams.get('tag') || 'all';
  const selectedTag = getBbnTag(selectedTagId);

  const setTag = useCallback((id: string) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    if (id === 'all') next.delete('tag');
    else next.set('tag', id);
    router.push(`/bbn?${next.toString()}`);
  }, [searchParams, router]);

  const hasLocked = openCount > 0 || upcomingCount > 0;

  return (
    <>
      <ScrollFadeBackdrop gradient={BBN_HUB_ART.gradient} imageUrl={BBN_HUB_ART.imageUrl} />

      {/* z-10 is load-bearing: the backdrop is a fixed z-0 layer, and
          non-positioned in-flow content paints BELOW that, so the art would
          cover the page without this. */}
      <div className="relative z-10 flex-1 min-w-0 px-3 py-4 md:p-6 space-y-4 md:space-y-5">
      <BBNHero
        openCount={openCount + tradingOpenCount}
        upcomingCount={upcomingCount}
        poolTngn={poolTngn + tradingVolumeTngn}
      />

      {/* Trading-engine markets first, because they're the newer, more
          engaging mode — you can sell out mid-season instead of waiting for
          finale night. Kept as its OWN clearly-labelled section rather than
          mixed into the locked-odds list below: a tradeable share and a
          fixed bet behave differently, and pretending they're the same
          thing in one feed would mislead, not simplify. */}
      {tradingMarkets.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-fuchsia-400" />
              <h2 className="text-sm font-semibold">Trade the season</h2>
            </div>
            <Link href="/open" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              All trading markets <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            Prices move as the house shifts. Buy a side and sell any time — you don&rsquo;t have to wait for the eviction.
          </p>
          <div className="space-y-3">
            {tradingMarkets.map(m => (
              <OpenMarketCard key={m.id} market={m} hideCategory />
            ))}
          </div>
        </section>
      )}

      {/* Locked-odds side. Only render its header + chips + list when it
          actually has markets — otherwise a "Predict & hold" heading over an
          empty list is the exact dead-end this hub is meant to avoid. */}
      {hasLocked && (
        <section className="space-y-3">
          {tradingMarkets.length > 0 && (
            <div className="flex items-center gap-2 pt-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold">Predict &amp; hold</h2>
            </div>
          )}

          {/* Market-type chips — scrollable on mobile like the football league
              tabs, but icon-led rather than text-only. This is the one place on
              the page that visually says "this isn't the sports hub." */}
          <div className="-mx-3 md:mx-0 overflow-x-auto no-scrollbar">
            <div className="flex gap-2 px-3 md:px-0 min-w-max">
              <TagChip
                icon={Flame}
                label="Everything"
                count={openCount}
                isActive={selectedTagId === 'all'}
                onClick={() => setTag('all')}
              />
              {BBN_TAG_IDS.map(id => {
                const tag = BBN_TAGS[id];
                const Icon = TAG_ICON[id];
                const count = tagCounts[id] ?? 0;
                // Only offer tags that have something in them. An empty chip a
                // viewer can tap into and find nothing is worse than not
                // offering it — it reads as a dead end, not a filter.
                if (count === 0) return null;
                return (
                  <TagChip
                    key={id}
                    icon={Icon}
                    label={tag.shortLabel}
                    count={count}
                    isActive={selectedTagId === id}
                    onClick={() => setTag(id)}
                  />
                );
              })}
            </div>
          </div>

          <MarketsToolbar />

          <MarketList
            leagueCode={selectedTag?.code}
            sport={selectedTag ? undefined : BBN_SPORT}
            scopeCategory="entertainment"
          />
        </section>
      )}
      </div>
    </>
  );
}

function TagChip({ icon: Icon, label, count, isActive, onClick }: {
  icon: typeof Trophy; label: string; count: number; isActive: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors whitespace-nowrap',
        isActive
          ? 'bg-fuchsia-500/15 border-fuchsia-500/50 text-fuchsia-300'
          : 'bg-muted/20 border-border/40 text-muted-foreground hover:text-foreground hover:border-border'
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
      <span className={cn('tabular text-[10px]', isActive ? 'text-fuchsia-300/70' : 'text-muted-foreground/60')}>
        {count}
      </span>
    </button>
  );
}

function BBNHero({ openCount, upcomingCount, poolTngn }: {
  openCount: number; upcomingCount: number; poolTngn: number;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10">
      {/* Stage lighting, not a hotlinked photo. Two soft glows on near-black
          rather than a blurred image — no external asset to break, and it
          reads as spotlight rather than a poster. */}
      <div className="absolute inset-0 bg-[#0a0a0d]">
        <div className="absolute inset-0"
             style={{ background: 'radial-gradient(ellipse 65vw 45vh at 8% -10%, rgba(217,70,239,0.28), transparent 60%), radial-gradient(ellipse 65vw 45vh at 105% 110%, rgba(245,158,11,0.20), transparent 60%)' }} />
      </div>

      {/* The eye motif: a generic "being watched" icon, not the show's
          trademarked logo — thematically on point for a 24-hour house
          without reproducing anyone's mark. */}
      <Eye className="absolute -right-4 -bottom-8 w-48 h-48 md:w-64 md:h-64 text-white/[0.05] rotate-[-6deg] pointer-events-none" strokeWidth={1} />

      <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center gap-5 p-6 md:p-8">
        <Link href="/markets" className="md:absolute md:top-4 md:left-4">
          <Button variant="ghost" size="icon" className="bg-black/30 backdrop-blur hover:bg-black/50 text-white">
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </Link>

        <div className="flex-1 min-w-0 md:ml-12">
          <div className="flex items-center gap-2 mb-1.5">
            {openCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/15 ring-1 ring-red-500/30 text-red-300 text-[10px] uppercase tracking-[0.14em] font-bold">
                <span className="relative flex w-1.5 h-1.5">
                  <span className="absolute inset-0 rounded-full bg-red-400 animate-pulse-slow" />
                </span>
                On Air
              </span>
            ) : (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-white/[0.06] ring-1 ring-white/10 text-white/50 text-[10px] uppercase tracking-[0.14em] font-bold">
                Between Seasons
              </span>
            )}
          </div>

          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-white drop-shadow-lg">
            Big Brother Naija
          </h1>
          <p className="text-sm md:text-base text-white/60 mt-1">
            Every eviction. Every twist. Real money on who&rsquo;s left.
          </p>

          <div className="flex gap-3 mt-4 text-xs flex-wrap">
            <div className="px-3 py-1.5 rounded-md bg-white/10 backdrop-blur ring-1 ring-white/10 text-white">
              <span className="font-semibold tabular">{openCount}</span>
              <span className="text-white/60 ml-1.5">open</span>
            </div>
            <div className="px-3 py-1.5 rounded-md bg-white/10 backdrop-blur ring-1 ring-white/10 text-white">
              <span className="font-semibold tabular">{upcomingCount}</span>
              <span className="text-white/60 ml-1.5">closing this week</span>
            </div>
            {poolTngn > 0 && (
              <div className="px-3 py-1.5 rounded-md bg-amber-500/10 backdrop-blur ring-1 ring-amber-500/20 text-amber-200">
                <span className="font-semibold tabular">{ngn(poolTngn)}</span>
                <span className="text-amber-200/60 ml-1.5">staked</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
