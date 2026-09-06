'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Trophy, Flame, Clock, BarChart3, ChevronDown, User, Receipt, Bitcoin, Vote, Crown, LineChart, PenLine, Eye } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type Subcategory = { id: string; label: string; href?: string; category?: string };
type Category = {
  id: string;
  label: string;
  icon: any;
  color: string;
  href?: string;
  subcategories?: Subcategory[];
};

// Sports → Football lands on the dedicated /football hub (league tabs +
// search + filters live on that page now, not in the sidebar). Fights is
// its OWN top-level filter (category=fight) — used to route as
// category=sports+subcategory=fight which broke buildCategoryFilter and
// silently included UFC under "Ball". Politics + Crypto are top-level
// again per the latest board call.
const CATEGORIES: Category[] = [
  { id: 'trending', label: 'Trending', icon: Flame, color: 'text-orange-500' },
  { id: 'new', label: 'New', icon: Clock, color: 'text-sky-400' },
  {
    id: 'sports',
    label: 'Sports',
    icon: Trophy,
    color: 'text-yellow-500',
    subcategories: [
      // Each of these has its own hub page now, so they route by href rather
      // than through the markets-page category filter. Fights used to be
      // `category: 'fight'` — it kept working, but a filtered list has no
      // room for competition tabs or a backdrop, which is what the hub adds.
      { id: 'football', label: '⚽ Football', href: '/football' },
      { id: 'basketball', label: '🏀 Basketball', href: '/basketball' },
      { id: 'tennis', label: '🎾 Tennis', href: '/tennis' },
      { id: 'esports', label: '🎮 Esports', href: '/esports' },
      { id: 'fight', label: '🥊 Boxing & MMA', href: '/fight' },
    ],
  },
  // Its own top-level entry, not a Sports/Economy subcategory: BBN isn't a
  // sport and lumping it into "Everything Economy" (where entertainment
  // otherwise lives) buries the one section built to feel like a live event.
  // href routes straight to its own hub (like Football does), bypassing the
  // markets-page category filter entirely — BBN markets are tagged
  // category='entertainment' + sport='bbn', not category='bbn'.
  { id: 'bbn', label: 'Big Brother Naija', icon: Eye, color: 'text-fuchsia-400', href: '/bbn' },
  { id: 'politics', label: 'Politics', icon: Vote, color: 'text-green-500' },
  { id: 'crypto', label: 'Crypto', icon: Bitcoin, color: 'text-amber-400' },
  { id: 'economy', label: 'Everything Economy', icon: BarChart3, color: 'text-emerald-500' },
];

export function Sidebar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const currentCategory = searchParams.get('category') || 'trending';
  const currentSubcategory = searchParams.get('subcategory');

  const [isSportsOpen, setIsSportsOpen] = useState(currentCategory === 'sports');

  const handleNavigation = (category: string, subcategory?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('category', category);
    if (subcategory) {
      params.set('subcategory', subcategory);
    } else {
      params.delete('subcategory');
    }
    router.push(`/markets?${params.toString()}`);
  };

  return (
    <div className="w-64 border-r bg-background min-h-screen p-4 flex flex-col gap-1 md:flex">
      {/* Leaderboard — promoted to its own section above the user links
          and the market category list. We rendered it inside the Profile
          / Picks group originally, but that group was wrapped in
          `hidden md:flex` (kept off mobile because the bottom tab bar
          covers Profile + Picks there), so Leaderboard disappeared
          entirely on phones. Split it out, give it a visible label, and
          render on every breakpoint. */}
      <div className="flex flex-col gap-1 mb-3 border-b pb-3">
        <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-muted-foreground px-3 mb-1">
          League
        </p>
        <Button
          variant={pathname?.startsWith('/leaderboard') ? 'secondary' : 'ghost'}
          className="w-full justify-start gap-2 hover:bg-muted/50"
          onClick={() => router.push('/leaderboard')}
        >
          <Crown className="h-4 w-4 text-amber-400 drop-shadow-[0_0_8px_currentColor]" /> Leaderboard
        </Button>
      </div>

      {/* Open Markets is a SEPARATE engine, not another category filter. It
          gets its own block rather than joining CATEGORIES below, because
          those route through handleNavigation with a ?category= param — a
          filter over the locked-odds markets, which is not what this is.
          Rendered on every breakpoint: nothing else in the app links to it. */}
      <div className="flex flex-col gap-1 mb-3 border-b pb-3">
        <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-emerald-400/90 px-3 mb-1">
          Trade
        </p>
        <Button
          variant={pathname?.startsWith('/open') && !pathname?.startsWith('/open/creator') ? 'secondary' : 'ghost'}
          className="w-full justify-start gap-2 hover:bg-muted/50"
          onClick={() => router.push('/open')}
        >
          <LineChart className="h-4 w-4 text-emerald-400" /> Browse
        </Button>
        <Button
          variant={pathname?.startsWith('/open/creator') ? 'secondary' : 'ghost'}
          className="w-full justify-start gap-2 hover:bg-muted/50"
          onClick={() => router.push('/open/creator')}
        >
          <PenLine className="h-4 w-4 text-emerald-400" /> Create &amp; earn
        </Button>
      </div>

      {/* Desktop-only top links — duplicates Profile + Picks from the
          mobile bottom tab bar, so they stay hidden on mobile to avoid
          two entry points for the same destination at once. */}
      <div className="hidden md:flex flex-col gap-1 mb-4 border-b pb-4">
        <Button variant="ghost" className="w-full justify-start gap-2 hover:bg-muted/50" onClick={() => router.push('/profile')}>
          <User className="h-4 w-4" /> Profile
        </Button>
        <Button variant="ghost" className="w-full justify-start gap-2 hover:bg-muted/50" onClick={() => router.push('/bets')}>
          <Receipt className="h-4 w-4" /> Picks
        </Button>
      </div>

      {CATEGORIES.map((category) => {
        const Icon = category.icon;
        const isActive = currentCategory === category.id;

        if (category.id === 'sports') {
          return (
            <Collapsible key={category.id} open={isSportsOpen} onOpenChange={setIsSportsOpen} className="w-full">
              <CollapsibleTrigger asChild>
                <Button
                  variant={isActive && !isSportsOpen ? 'secondary' : 'ghost'}
                  className={cn('w-full justify-between gap-2 hover:bg-muted/50', isActive && !isSportsOpen && 'bg-muted')}
                >
                  <div className="flex items-center gap-2">
                    {Icon && <Icon className={cn('h-4 w-4 drop-shadow-[0_0_8px_currentColor]', category.color)} />}
                    {category.label}
                  </div>
                  <ChevronDown className={cn('h-4 w-4 transition-transform', isSportsOpen && 'rotate-180')} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pl-4 pr-2 py-1 space-y-1">
                {category.subcategories?.map(sub => {
                  // Active state has to be resolved the same way navigation
                  // is, or the highlight lands on the wrong row: an href
                  // subcategory leaves the markets page entirely, so its
                  // ?category / ?subcategory params are gone and checking
                  // them would never match.
                  const isActive = sub.href
                    ? !!pathname?.startsWith(sub.href)
                    : sub.category
                      ? currentCategory === sub.category
                      : currentSubcategory === sub.id;
                  return (
                    <Button
                      key={sub.id}
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="sm"
                      className="w-full justify-start text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        if (sub.href) router.push(sub.href);
                        else if (sub.category) handleNavigation(sub.category);
                        else handleNavigation(category.id, sub.id);
                      }}
                    >
                      {sub.label}
                    </Button>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          );
        }

        return (
          <Button
            key={category.id}
            variant={category.href ? (pathname?.startsWith(category.href) ? 'secondary' : 'ghost')
                                    : (isActive ? 'secondary' : 'ghost')}
            className={cn('w-full justify-start gap-2 hover:bg-muted/50',
              (category.href ? pathname?.startsWith(category.href) : isActive) && 'bg-muted')}
            onClick={() => category.href ? router.push(category.href) : handleNavigation(category.id)}
          >
            {Icon && <Icon className={cn('h-4 w-4 drop-shadow-[0_0_8px_currentColor]', category.color)} />}
            <span className={!Icon ? 'ml-6' : ''}>{category.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
