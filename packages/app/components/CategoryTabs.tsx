'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useRef, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Sparkles, Trophy, Swords, Landmark, Coins,
} from 'lucide-react';

// The 4 categories the board signed off on. "Trending" stays as a meta-tab
// so users have a home-feed view. Filter mapping happens in MarketList.
const TABS = [
  { id: 'trending', label: 'Trending', Icon: Sparkles },
  { id: 'ball', label: 'Ball', Icon: Trophy },
  { id: 'fight', label: 'Fight', Icon: Swords },
  { id: 'politics', label: 'Politics', Icon: Landmark },
  { id: 'economy', label: 'Everything Economy', Icon: Coins },
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
        {TABS.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              data-tab-id={id}
              onClick={() => setCategory(id)}
              className={cn(
                'shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
