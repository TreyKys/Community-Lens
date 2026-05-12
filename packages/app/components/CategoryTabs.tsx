'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useRef, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Sparkles, Trophy, Music2, Landmark, Cpu, Bitcoin, MapPin, Tv,
} from 'lucide-react';

// Polymarket-style horizontal tab bar that drives the ?category= query param
// the existing MarketList already understands.
const TABS = [
  { id: 'trending', label: 'Trending', Icon: Sparkles },
  { id: 'sports', label: 'Sports', Icon: Trophy },
  { id: 'entertainment', label: 'Pop Culture', Icon: Music2 },
  { id: 'politics', label: 'Politics', Icon: Landmark },
  { id: 'tech', label: 'Tech', Icon: Cpu },
  { id: 'crypto', label: 'Crypto', Icon: Bitcoin },
  { id: 'economy', label: 'Naija', Icon: MapPin },
  { id: 'geo', label: 'World', Icon: Tv },
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
