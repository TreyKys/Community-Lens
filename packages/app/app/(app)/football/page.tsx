import { Suspense } from 'react';
import { FootballHub } from '@/components/FootballHub';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Football · Opinions.ng',
  description: 'Every football market across every league — Premier League, LaLiga, Serie A, Bundesliga, Ligue 1, UCL, World Cup and more.',
};

export default function FootballPage() {
  return (
    <div className="relative flex flex-col min-h-screen pb-20 md:pb-0">
      <Suspense fallback={<div className="p-4 space-y-4">
        <div className="h-8 w-40 rounded shimmer" />
        <div className="h-10 rounded-lg shimmer" />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-36 rounded-xl shimmer" />
          ))}
        </div>
      </div>}>
        <FootballHub />
      </Suspense>
    </div>
  );
}
