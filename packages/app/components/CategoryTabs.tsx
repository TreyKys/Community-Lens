'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useRef, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Sparkles, Clock, Trophy, Swords, Landmark, Coins,
  Eye, TrendingUp, Gamepad2, CircleDot, Zap,
} from 'lucide-react';

// Tab model: Trending = admin-curated featured set (a few hot ones);
// New = everything else, newest first. Splitting them stops "Trending"
// from meaning "everything" — the hot Golden Boot / Messi / group
// winner markets stay surfaced instead of getting buried by the long
// tail of less popular markets.
//
// Two kinds of entry live in this rail, and the difference matters:
//
//   FILTERS (no href)  -- stay on /markets and set ?category=
//   HUBS   (with href) -- leave for a dedicated page with its own backdrop
//
// The hubs were previously reachable only through the mobile Menu sheet, so in
// practice nobody found them: /markets is the screen people actually open, and
// it looked exactly as it always had. A hub nobody can reach is a hub that
// does not exist.
//
// Hubs sit early -- right after Trending and New -- because they are the point
// of difference, not an afterthought at the end of a scrolling rail.
const TABS = [
  { id: 'trending', label: 'Trending', Icon: Sparkles },
  { id: 'new',      label: 'New',      Icon: Clock },
  { id: 'open',     label: 'Trade',    Icon: TrendingUp, href: '/open',       accent: 'text-emerald-400' },
  { id: 'bbn',      label: 'BBN',      Icon: Eye,        href: '/bbn',        accent: 'text-fuchsia-400' },
  { id: 'ball',     label: 'Ball',     Icon: Trophy },
  { id: 'basketball', label: 'Basketball', Icon: CircleDot, href: '/basketball', accent: 'text-orange-400' },
  { id: 'tennis',   label: 'Tennis',   Icon: Zap,        href: '/tennis',     accent: 'text-lime-400' },
  { id: 'esports',  label: 'Esports',  Icon: Gamepad2,   href: '/esports',    accent: 'text-violet-400' },
  { id: 'fight',    label: 'Fight',    Icon: Swords,     href: '/fight',      accent: 'text-red-400' },
  { id: 'politics', label: 'Politics', Icon: Landmark },
  { id: 'economy',  label: 'Everything Economy', Icon: Coins },
] as const;

export function CategoryTabs() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const active = searchParams.get('category') || 'trending';
  const railRef = useRef<HTMLDivElement>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(true);

  // Scroll the active tab into view when it changes.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const activeBtn = rail.querySelector<HTMLButtonElement>(`[data-tab-id="${active}"]`);
    activeBtn?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [active]);

  // Update fade indicators based on scroll position.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => {
      setShowLeftFade(rail.scrollLeft > 8);
      setShowRightFade(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 8);
    };
    update();
    rail.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      rail.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const setCategory = (id: string) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set('category', id);
    // Drop subcategory when switching top-level tabs to avoid stale filters.
    params.delete('subcategory');
    router.push(`/markets?${params.toString()}`);
  };

  return (
    // w-full + min-w-0 so the rail scrolls within its own container instead of
    // pushing the page wider. Border lives on the wrapper so it spans full width
    // even after the inner rail scrolls.
    <div className="relative w-full min-w-0 border-b border-border/50">
      {showLeftFade && (
        <div className="absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-background to-transparent pointer-events-none z-10" />
      )}
      {showRightFade && (
        <div className="absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-background to-transparent pointer-events-none z-10" />
      )}
      <div
        ref={railRef}
        className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TABS.map((tab) => {
          const { id, label, Icon } = tab;
          const href = 'href' in tab ? tab.href : undefined;
          const accent = 'accent' in tab ? tab.accent : undefined;
          const isActive = !href && active === id;
          return (
            <button
              key={id}
              data-tab-id={id}
              onClick={() => href ? router.push(href) : setCategory(id)}
              className={cn(
                'shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              )}
            >
              {/* Hubs keep their accent colour on the icon even when inactive.
                  It is the only signal in the rail saying "this one goes
                  somewhere else"; without it they read as more filters. */}
              <Icon className={cn('w-4 h-4', !isActive && accent)} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
