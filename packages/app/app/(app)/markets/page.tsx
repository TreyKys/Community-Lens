'use client';

import { Suspense } from 'react';
import { MarketList } from '@/components/MarketList';

export default function MarketsPage() {
  return (
    <div className="container mx-auto p-8 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 items-center sm:items-start w-full">
        <h1 className="text-4xl font-bold mb-8 text-center sm:text-left w-full">
            Active Markets
            <span className="block text-muted-foreground text-lg font-light mt-1">Bet on your favorite outcomes.</span>
        </h1>

        <div className="w-full">
            <Suspense fallback={<div className="p-8 text-center">Loading markets...</div>}>
                <MarketList />
            </Suspense>
        </div>
      </main>
    </div>
  );
}
