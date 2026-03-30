'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Trophy, Flame, Bitcoin, Globe, BarChart3, Cpu, Star, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const CATEGORIES = [
  { id: 'trending', label: 'Trending', icon: Flame, color: 'text-orange-500' },
  {
    id: 'sports',
    label: 'Sports',
    icon: Trophy,
    color: 'text-yellow-500',
    subcategories: [
      { id: 'football', label: 'Football', subItems: [
        { label: '[PL] Premier League', id: 'pl' },
        { label: '[PD] LaLiga', id: 'pd' },
        { label: '[SA] Serie A', id: 'sa' },
        { label: '[BL1] Bundesliga', id: 'bl1' },
        { label: '[FL1] Ligue 1', id: 'fl1' },
        { label: '[CL] Champions League', id: 'cl' },
        { label: '[WC] World Cup', id: 'wc' },
        { label: '[EC] Euros', id: 'ec' },
        { label: '[DED] Eredivisie', id: 'ded' },
        { label: '[BSA] Brasileirao', id: 'bsa' },
        { label: '[PPL] Primeira Liga', id: 'ppl' },
        { label: '[ELC] Championship', id: 'elc' }
      ] },
      { id: 'basketball', label: 'Basketball' },
      { id: 'fight', label: 'Fight Night' },
      { id: 'motorsport', label: 'Motorsport' },
      { id: 'esports', label: 'eSports' }
    ]
  },
  { id: 'politics', label: 'Naija Politics', icon: null, color: 'text-green-500' },
  { id: 'crypto', label: 'Crypto', icon: Bitcoin, color: 'text-yellow-600' },
  { id: 'pop', label: 'Pop Culture & Music', icon: Star, color: 'text-pink-500' },
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
  const [isFootballOpen, setIsFootballOpen] = useState(currentSubcategory === 'football');

  const handleNavigation = (category: string, subcategory?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('category', category);
    if (subcategory) {
      params.set('subcategory', subcategory);
    } else {
      params.delete('subcategory');
    }
    router.push(`/?${params.toString()}`);
  };

  return (
    <div className="w-64 border-r bg-background h-screen overflow-y-auto p-4 flex flex-col gap-1 md:flex pb-24">
      {CATEGORIES.map((category) => {
        const Icon = category.icon;
        const isActive = currentCategory === category.id;

        if (category.id === 'sports') {
          return (
            <Collapsible key={category.id} open={isSportsOpen} onOpenChange={setIsSportsOpen} className="w-full">
              <CollapsibleTrigger asChild>
                <Button
                  variant={isActive && !isSportsOpen ? "secondary" : "ghost"}
                  className={cn("w-full justify-between gap-2 hover:bg-muted/50", isActive && !isSportsOpen && "bg-muted")}
                  onClick={() => handleNavigation(category.id)}
                >
                  <div className="flex items-center gap-2">
                    {Icon && <Icon className={cn("h-4 w-4 drop-shadow-[0_0_8px_rgba(234,179,8,0.8)]", category.color)} />}
                    {category.label}
                  </div>
                  <ChevronDown className={cn("h-4 w-4 transition-transform", isSportsOpen && "rotate-180")} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pl-4 pr-2 py-1 space-y-1">
                {category.subcategories?.map(sub => {
                  if (sub.id === 'football') {
                    return (
                      <Collapsible key={sub.id} open={isFootballOpen} onOpenChange={setIsFootballOpen} className="w-full">
                         <CollapsibleTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full justify-between text-muted-foreground hover:text-foreground"
                            >
                               {sub.label}
                               <ChevronDown className={cn("h-3 w-3 transition-transform", isFootballOpen && "rotate-180")} />
                            </Button>
                         </CollapsibleTrigger>
                         <CollapsibleContent className="pl-6 py-1 space-y-1 border-l ml-2 mt-1">
                            {sub.subItems?.map(item => (
                                <Button
                                  key={item.id}
                                  variant={currentSubcategory === item.id ? "secondary" : "ghost"}
                                  size="sm"
                                  className={cn("w-full justify-start text-xs text-muted-foreground hover:text-foreground h-7", currentSubcategory === item.id && "text-foreground bg-muted")}
                                  onClick={() => handleNavigation(category.id, item.id)}
                                >
                                  {item.label}
                                </Button>
                            ))}
                         </CollapsibleContent>
                      </Collapsible>
                    )
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
                  )
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
