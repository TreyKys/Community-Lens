'use client';

import { Suspense } from 'react';
import { MarketList } from '@/components/MarketList';

export default function Home() {
  return (
    <div className="container mx-auto p-4 md:p-8 font-[family-name:var(--font-geist-sans)] max-w-3xl">
      <main className="flex flex-col gap-6 items-center sm:items-start w-full">
        <div className="w-full">
            <Suspense fallback={<div className="p-8 text-center">Loading markets...</div>}>
                <MarketList />
            </Suspense>
        </div>
      </main>
    </div>
  );
}
