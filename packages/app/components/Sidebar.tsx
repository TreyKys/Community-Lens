'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Trophy, Scale, Bitcoin, LayoutGrid } from 'lucide-react';

const CATEGORIES = [
  { id: 'all', label: 'All Markets', icon: LayoutGrid },
  { id: 'sports', label: 'Sports', icon: Trophy },
  { id: 'politics', label: 'Politics', icon: Scale },
  { id: 'crypto', label: 'Crypto', icon: Bitcoin },
];

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentCategory = searchParams.get('category') || 'all';

  const handleCategoryChange = (category: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (category === 'all') {
      params.delete('category');
    } else {
      params.set('category', category);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="w-64 border-r bg-background min-h-screen p-4 flex flex-col gap-2">
      <div className="font-semibold text-lg px-4 py-2 mb-2">Filters</div>
      {CATEGORIES.map((category) => {
        const Icon = category.icon;
        const isActive = currentCategory === category.id;
        return (
          <Button
            key={category.id}
            variant={isActive ? "secondary" : "ghost"}
            className={cn("w-full justify-start gap-2", isActive && "bg-muted")}
            onClick={() => handleCategoryChange(category.id)}
          >
            <Icon className="h-4 w-4" />
            {category.label}
          </Button>
        );
      })}
    </div>
  );
}
