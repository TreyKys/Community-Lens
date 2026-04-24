'use client';

import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { getLeague } from '@/lib/leagues';

export function MarketsBackdrop() {
  const searchParams = useSearchParams();
  const subcategory = searchParams.get('subcategory');
  const league = getLeague(subcategory);

  if (!league) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      <div className="absolute inset-0 opacity-[0.06]">
        <Image
          src={league.logoUrl}
          alt=""
          fill
          className="object-cover blur-2xl scale-125"
          sizes="100vw"
          unoptimized
        />
      </div>
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at top, ${league.accent}20, transparent 60%)`,
        }}
      />
    </div>
  );
}
