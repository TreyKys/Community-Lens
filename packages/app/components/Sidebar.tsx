'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Trophy, Flame, Bitcoin, Globe, BarChart3, Cpu, Star, ChevronDown, User, Receipt } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type SubItem = { label: string; id: string };
type Subcategory = { id: string; label: string; subItems?: SubItem[] };
type Category = {
  id: string;
  label: string;
  icon: any;
  color: string;
  subcategories?: Subcategory[];
};

const CATEGORIES: Category[] = [
  { id: 'trending', label: 'Trending', icon: Flame, color: 'text-orange-500' },
  {
    id: 'sports',
    label: 'Sports',
    icon: Trophy,
    color: 'text-yellow-500',
    subcategories: [
      { id: 'football', label: '⚽ Football', subItems: [
        { label: 'Premier League', id: 'pl' },
        { label: 'LaLiga', id: 'pd' },
        { label: 'Serie A', id: 'sa' },
        { label: 'Bundesliga', id: 'bl1' },
        { label: 'Ligue 1', id: 'fl1' },
        { label: 'Champions League', id: 'cl' },
        { label: 'World Cup', id: 'wc' },
        { label: 'Euros', id: 'ec' },
        { label: 'Eredivisie', id: 'ded' },
        { label: 'Brasileirao', id: 'bsa' },
        { label: 'Primeira Liga', id: 'ppl' },
        { label: 'Championship', id: 'elc' },
      ] },
      { id: 'basketball', label: '🏀 Basketball', subItems: [
        { label: 'NBA', id: 'nba' },
        { label: 'EuroLeague', id: 'euroleague' },
      ] },
      { id: 'fight', label: '🥊 Fight Night' },
      { id: 'motorsport', label: '🏎️ Motorsport' },
      { id: 'esports', label: '🎮 eSports', subItems: [
        { label: 'League of Legends', id: 'lol' },
        { label: 'CS:GO', id: 'csgo' },
        { label: 'Dota 2', id: 'dota2' },
        { label: 'Valorant', id: 'valorant' },
        { label: 'Rainbow Six Siege', id: 'r6s' },
      ] },
    ],
  },
  { id: 'politics', label: '🗳️ Naija Politics', icon: null, color: 'text-green-500' },
  { id: 'crypto', label: 'Crypto', icon: Bitcoin, color: 'text-yellow-600' },
  {
    id: 'entertainment',
    label: 'Entertainment',
    icon: Star,
    color: 'text-pink-500',
    subcategories: [
      { id: 'pop', label: '🍿 Pop Culture' },
      { id: 'reality', label: '🎬 Reality TV' },
      { id: 'nollywood', label: '🎥 Nollywood' },
      { id: 'afrobeats', label: '🎶 Afrobeats' },
      { id: 'music', label: '🎵 Music' },
    ],
  },
  { id: 'geo', label: 'Geopolitics', icon: Globe, color: 'text-blue-500' },
  { id: 'economy', label: 'Economy', icon: BarChart3, color: 'text-emerald-500' },
  { id: 'tech', label: 'Tech & AI', icon: Cpu, color: 'text-purple-500' },
];

export function Sidebar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentCategory = searchParams.get('category') || 'trending';
  const currentSubcategory = searchParams.get('subcategory');

  const [isSportsOpen, setIsSportsOpen] = useState(currentCategory === 'sports');
  const [isEntertainmentOpen, setIsEntertainmentOpen] = useState(currentCategory === 'entertainment');
  const [openSubs, setOpenSubs] = useState<Record<string, boolean>>(() => ({
    [currentSubcategory ?? '']: true,
  }));

  const toggleSub = (id: string, value?: boolean) =>
    setOpenSubs((prev) => ({ ...prev, [id]: value ?? !prev[id] }));

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
      {/* Desktop Top Links */}
      <div className="hidden md:flex flex-col gap-1 mb-4 border-b pb-4">
        <Button variant="ghost" className="w-full justify-start gap-2 hover:bg-muted/50" onClick={() => router.push('/profile')}>
          <User className="h-4 w-4" /> Profile
        </Button>
        <Button variant="ghost" className="w-full justify-start gap-2 hover:bg-muted/50" onClick={() => router.push('/bets')}>
          <Receipt className="h-4 w-4" /> Bets
        </Button>
      </div>

      {CATEGORIES.map((category) => {
        const Icon = category.icon;
        const isActive = currentCategory === category.id;

        if (category.id === 'sports' || category.id === 'entertainment') {
          const isOpen = category.id === 'sports' ? isSportsOpen : isEntertainmentOpen;
          const setIsOpen = category.id === 'sports' ? setIsSportsOpen : setIsEntertainmentOpen;

          return (
            <Collapsible key={category.id} open={isOpen} onOpenChange={setIsOpen} className="w-full">
              <CollapsibleTrigger asChild>
                <Button
                  variant={isActive && !isOpen ? "secondary" : "ghost"}
                  className={cn("w-full justify-between gap-2 hover:bg-muted/50", isActive && !isOpen && "bg-muted")}
                  onClick={() => handleNavigation(category.id)}
                >
                  <div className="flex items-center gap-2">
                    {Icon && <Icon className={cn("h-4 w-4", category.id === 'sports' ? "drop-shadow-[0_0_8px_rgba(234,179,8,0.8)]" : "drop-shadow-[0_0_8px_rgba(236,72,153,0.8)]", category.color)} />}
                    {category.label}
                  </div>
                  <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pl-4 pr-2 py-1 space-y-1">
                {category.subcategories?.map(sub => {
                  if (sub.subItems && sub.subItems.length) {
                    const subOpen = !!openSubs[sub.id];
                    const useLeagueRoute = sub.id === 'football';
                    return (
                      <Collapsible key={sub.id} open={subOpen} onOpenChange={(v) => toggleSub(sub.id, v)} className="w-full">
                        <CollapsibleTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-between text-muted-foreground hover:text-foreground"
                          >
                            {sub.label}
                            <ChevronDown className={cn("h-3 w-3 transition-transform", subOpen && "rotate-180")} />
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pl-6 py-1 space-y-1 border-l ml-2 mt-1">
                          {sub.subItems.map(item => (
                            <Button
                              key={item.id}
                              variant={currentSubcategory === item.id ? "secondary" : "ghost"}
                              size="sm"
                              className={cn("w-full justify-start text-xs text-muted-foreground hover:text-foreground h-7", currentSubcategory === item.id && "text-foreground bg-muted")}
                              onClick={() =>
                                useLeagueRoute
                                  ? router.push(`/league/${item.id}`)
                                  : handleNavigation(category.id, item.id)
                              }
                            >
                              {item.label}
                            </Button>
                          ))}
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  }

                  return (
                    <Button
                      key={sub.id}
                      variant={currentSubcategory === sub.id ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start text-muted-foreground hover:text-foreground"
                      onClick={() => handleNavigation(category.id, sub.id)}
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
            variant={isActive ? "secondary" : "ghost"}
            className={cn("w-full justify-start gap-2 hover:bg-muted/50", isActive && "bg-muted")}
            onClick={() => handleNavigation(category.id)}
          >
            {Icon && <Icon className={cn(`h-4 w-4 drop-shadow-[0_0_8px_currentColor]`, category.color)} />}
            <span className={!Icon ? "ml-6" : ""}>{category.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
