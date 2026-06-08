'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Trophy, Flame, BarChart3, ChevronDown, User, Receipt, Bitcoin, Vote } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type Subcategory = { id: string; label: string; href?: string };
type Category = {
  id: string;
  label: string;
  icon: any;
  color: string;
  href?: string;
  subcategories?: Subcategory[];
};

// Sports → Football lands on the dedicated /football hub (league tabs +
// search + filters live on that page now, not in the sidebar). Fights stays
// as a category-filtered link to the markets list. Politics + Crypto are
// top-level again per the latest board call.
const CATEGORIES: Category[] = [
  { id: 'trending', label: 'Trending', icon: Flame, color: 'text-orange-500' },
  {
    id: 'sports',
    label: 'Sports',
    icon: Trophy,
    color: 'text-yellow-500',
    subcategories: [
      { id: 'football', label: '⚽ Football', href: '/football' },
      { id: 'fight', label: '🥊 Fights' },
    ],
  },
  { id: 'politics', label: 'Politics', icon: Vote, color: 'text-green-500' },
  { id: 'crypto', label: 'Crypto', icon: Bitcoin, color: 'text-amber-400' },
  { id: 'economy', label: 'Everything Economy', icon: BarChart3, color: 'text-emerald-500' },
];

export function Sidebar() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
      {/* Desktop Top Links */}
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
                {category.subcategories?.map(sub => (
                  <Button
                    key={sub.id}
                    variant={currentSubcategory === sub.id ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      sub.href ? router.push(sub.href) : handleNavigation(category.id, sub.id)
                    }
                  >
                    {sub.label}
                  </Button>
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        }

        return (
          <Button
            key={category.id}
            variant={isActive ? 'secondary' : 'ghost'}
            className={cn('w-full justify-start gap-2 hover:bg-muted/50', isActive && 'bg-muted')}
            onClick={() => handleNavigation(category.id)}
          >
            {Icon && <Icon className={cn('h-4 w-4 drop-shadow-[0_0_8px_currentColor]', category.color)} />}
            <span className={!Icon ? 'ml-6' : ''}>{category.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
