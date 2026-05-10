'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { Flame, TrendingUp, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface PopularMarket {
  id: number;
  question: string;
  category: string;
  total_pool: number;
  closes_at: string;
  options: string[];
  status: 'open' | 'locked' | 'resolved' | 'voided';
}

// Tag accent — colour pill by category so the rail feels alive instead of grey.
function categoryAccent(category: string): { bg: string; text: string; label: string } {
  switch (category) {
    case 'sports': return { bg: 'bg-emerald-500/15', text: 'text-emerald-300', label: 'Sports' };
    case 'politics': return { bg: 'bg-orange-500/15', text: 'text-orange-300', label: 'Politics' };
    case 'finance': return { bg: 'bg-amber-500/15', text: 'text-amber-300', label: 'Finance' };
    case 'economics': return { bg: 'bg-amber-500/15', text: 'text-amber-300', label: 'Economy' };
    case 'entertainment': return { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-300', label: 'Pop' };
    default: return { bg: 'bg-muted', text: 'text-muted-foreground', label: category };
  }
}

export function PopularMarketsScroll() {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [markets, setMarkets] = useState<PopularMarket[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Top open markets ordered by stake volume — true "popular" signal.
      const cutoff = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('markets')
        .select('id, question, category, total_pool, closes_at, options, status')
        .not('status', 'eq', 'voided')
        .or(`status.neq.resolved,resolved_at.gte.${cutoff}`)
        .is('parent_market_id', null)
        .order('total_pool', { ascending: false })
        .limit(12);
      if (!cancelled && data) setMarkets(data as PopularMarket[]);
      if (!cancelled) setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-scroll the rail every 4s — pauses while user is interacting.
  useEffect(() => {
    if (markets.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    let paused = false;
    const onEnter = () => { paused = true; };
    const onLeave = () => { paused = false; };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('touchstart', onEnter, { passive: true });
    el.addEventListener('touchend', onLeave, { passive: true });

    const interval = setInterval(() => {
      if (paused) return;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
      el.scrollTo({ left: atEnd ? 0 : el.scrollLeft + 280, behavior: 'smooth' });
    }, 4000);

    return () => {
      clearInterval(interval);
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('touchstart', onEnter);
      el.removeEventListener('touchend', onLeave);
    };
  }, [markets.length]);

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Flame className="w-4 h-4 text-orange-400" /> Popular Right Now
        </div>
        <div className="flex gap-3 overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 w-64 shrink-0 rounded-xl shimmer" />
          ))}
        </div>
      </div>
    );
  }

  if (markets.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Flame className="w-4 h-4 text-orange-400" /> Popular Right Now
        </div>
        <div className="hidden md:flex gap-1">
          <button
            onClick={() => scrollBy(-280)}
            className="p-1 rounded-md border border-border/50 hover:bg-muted/50 transition-colors"
            aria-label="Scroll left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scrollBy(280)}
            className="p-1 rounded-md border border-border/50 hover:bg-muted/50 transition-colors"
            aria-label="Scroll right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 md:-mx-0 md:px-0 snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {markets.map(m => {
          const accent = categoryAccent(m.category);
          const closesAt = new Date(m.closes_at);
          const isOpen = m.status === 'open' && closesAt > new Date();
          const cleanQuestion = m.question.replace(/\[.*?\]\s*/g, '').trim();
          return (
            <button
              key={m.id}
              onClick={() => router.push(`/event/${m.id}`)}
              className="snap-start shrink-0 w-64 md:w-72 text-left p-3 rounded-xl border border-border/60 bg-card hover:border-foreground/30 hover:shadow-lg transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <Badge className={cn('text-[10px] border-0', accent.bg, accent.text)}>{accent.label}</Badge>
                {isOpen && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
                    </span>
                    LIVE
                  </span>
                )}
              </div>
              <p className="text-sm font-medium text-foreground line-clamp-2 mb-3 group-hover:text-foreground">
                {cleanQuestion}
              </p>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" />
                  ₦{(m.total_pool || 0).toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {closesAt.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
