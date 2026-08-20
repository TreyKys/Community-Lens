import { Suspense } from 'react';
import { SportHub } from '@/components/SportHub';
import { SPORT_HUBS } from '@/lib/sportHubs';

// Thin route wrapper. Everything about this sport — label, accent, backdrop
// art, competitions — lives in lib/sportHubs.ts, so adding another hub is a
// config entry plus a copy of this file.
const HUB = SPORT_HUBS.tennis;

export const dynamic = 'force-dynamic';

export const metadata = {
  title: `${HUB.label} · Opinions.ng`,
  description: HUB.tagline,
};

export default function TennisPage() {
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
        <SportHub hub={HUB} />
      </Suspense>
    </div>
  );
}
