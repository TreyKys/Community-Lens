'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-65px)] p-8 text-center bg-gradient-to-b from-background to-muted/20">
      <main className="flex flex-col gap-6 max-w-2xl items-center">
        <h1 className="text-6xl font-extrabold tracking-tight">
          TruthMarket
        </h1>
        <p className="text-2xl text-muted-foreground font-light">
          The Global Prediction Layer.
        </p>
        <p className="text-lg text-muted-foreground/80 max-w-lg">
          Bet on Sports, Politics, and Crypto with instant settlements and guaranteed liquidity.
        </p>

        <div className="flex gap-4 justify-center mt-8">
            <Link href="/markets">
                <Button size="lg" className="text-lg px-8 py-6 h-auto">
                    Launch App
                </Button>
            </Link>
        </div>
      </main>

      <footer className="mt-16 text-center text-sm text-muted-foreground pt-8">
        <p>TruthMarket &copy; {new Date().getFullYear()} - Decentralized Prediction Market on Polygon Amoy</p>
      </footer>
    </div>
  );
}
