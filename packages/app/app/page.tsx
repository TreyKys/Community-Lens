'use client';

import { MarketList } from '@/components/MarketList';

export default function Home() {
  return (
    <div className="container mx-auto p-8 pb-20 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 items-center sm:items-start w-full">
        <h1 className="text-4xl font-bold mb-8 text-center sm:text-left w-full">TruthMarket <span className="text-muted-foreground text-2xl font-light">| Prediction Markets</span></h1>

        <div className="w-full">
            <h2 className="text-2xl font-semibold mb-6">Upcoming Matches</h2>
            <MarketList />
        </div>
      </main>

      <footer className="mt-16 text-center text-sm text-muted-foreground border-t pt-8 w-full">
        <p>TruthMarket &copy; {new Date().getFullYear()} - Decentralized Prediction Market on Polygon Amoy</p>
      </footer>
    </div>
  );
}
