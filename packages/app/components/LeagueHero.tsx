import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { League } from '@/lib/leagues';

interface LeagueHeroProps {
  league: League;
  activeCount?: number;
  upcomingCount?: number;
}

export function LeagueHero({ league, activeCount = 0, upcomingCount = 0 }: LeagueHeroProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-muted/50 mb-6">
      <div className="absolute inset-0">
        <Image
          src={league.logoUrl}
          alt={league.label}
          fill
          priority
          className="object-cover scale-110 blur-xl opacity-40"
          sizes="100vw"
          unoptimized
        />
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(135deg, ${league.accent}cc 0%, rgba(0,0,0,0.85) 60%, rgba(0,0,0,0.95) 100%)`,
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
      </div>

      <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center gap-5 p-6 md:p-8">
        <Link href="/markets" className="md:absolute md:top-4 md:left-4">
          <Button variant="ghost" size="icon" className="bg-black/30 backdrop-blur hover:bg-black/50 text-white">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>

        <div className="relative h-24 w-24 md:h-32 md:w-32 shrink-0 rounded-xl overflow-hidden bg-white/10 backdrop-blur ring-1 ring-white/20 ml-0 md:ml-12">
          <Image
            src={league.logoUrl}
            alt={`${league.label} logo`}
            fill
            className="object-contain p-2"
            sizes="128px"
            unoptimized
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.2em] text-white/60 mb-1">League</div>
          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-white drop-shadow-lg">
            {league.label}
          </h1>
          <p className="text-sm md:text-base text-white/70 mt-1">{league.tagline}</p>

          <div className="flex gap-3 mt-4 text-xs">
            <div className="px-3 py-1.5 rounded-md bg-white/10 backdrop-blur ring-1 ring-white/10 text-white">
              <span className="font-semibold">{activeCount}</span>
              <span className="text-white/60 ml-1.5">open</span>
            </div>
            <div className="px-3 py-1.5 rounded-md bg-white/10 backdrop-blur ring-1 ring-white/10 text-white">
              <span className="font-semibold">{upcomingCount}</span>
              <span className="text-white/60 ml-1.5">upcoming</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
