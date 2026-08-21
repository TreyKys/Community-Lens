'use client';

import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { getLeague } from '@/lib/leagues';

export function MarketsBackdrop() {
  const searchParams = useSearchParams();
  const subcategory = searchParams.get('subcategory');
  const league = getLeague(subcategory);

  // A league is selected — keep the existing per-league treatment.
  if (league) {
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

  // No league selected — which is the DEFAULT state, and what almost every
  // visitor sees. This used to return null, so /markets (the screen people
  // actually open) had no backdrop at all while every hub page had one. The
  // main list looked untouched next to pages that had clearly been designed.
  //
  // Static, and deliberately so: globals.css documents an earlier version of
  // the site backdrop that banded visibly on Mali/Adreno GPUs because it
  // animated a blurred gradient. Two flat radial washes cost nothing to
  // rasterise and cannot do that.
  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80vw 55vh at 12% -10%, rgba(27,202,121,0.13), transparent 62%),'
          + 'radial-gradient(ellipse 75vw 50vh at 105% 8%, rgba(16,185,129,0.09), transparent 60%)',
        }}
      />
      {/* Grounds the whole thing back to the page colour before the fold, so
          content never sits on raw gradient. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/50 to-background" />
    </div>
  );
}
