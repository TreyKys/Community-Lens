'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Flame, TrendingUp, TrendingDown, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

// "Moving now" — the markets where the crowd changed its mind today.
//
// The markets page is a wall of cards that never change while you look at
// them, and nothing on it says which of forty questions is worth your
// attention. That flatness is most of what reads as dry: not the colours, the
// absence of anything happening.
//
// Two things do the work here, and both are borrowed rather than invented —
// live in-play movement and other people's activity are the two levers that
// consistently hold attention in this category:
//
//   MOVEMENT — a signed delta in percentage points, coloured, with an arrow.
//   PEOPLE   — trader count and money staked, because "340 people are in this"
//              is a far stronger reason to look than any gradient.
//
// Only renders when something has actually moved. An empty "Moving now" rail
// is worse than no rail: it says the site is dead.

type Mover = {
  id: string;
  engine: 'locked' | 'trading';
  question: string;
  topOutcome: string;
  pricePct: number;
  deltaPct: number;
  poolTngn: number;
  traders: number;
  href: string;
};

const ngnShort = (n: number) => {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${Math.round(n / 1_000)}k`;
  return `₦${Math.round(n)}`;
};

export function MoversRail() {
  const router = useRouter();
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/markets/movers?limit=8')
      .then(r => r.json())
      .then(d => { if (alive) setMovers(d.movers || []); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });

    load();
    // Refresh while the tab is open so the rail is genuinely live rather than
    // a snapshot from whenever the page was opened. Paused when the tab is
    // hidden — polling a backgrounded tab burns a phone battery for nothing.
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (loading) {
    return (
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2].map(i => <div key={i} className="h-[92px] w-52 shrink-0 rounded-xl shimmer" />)}
      </div>
    );
  }

  // Nothing moved — say nothing. See header.
  if (movers.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 px-0.5">
        <Flame className="w-3.5 h-3.5 text-orange-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Moving now
        </h2>
        <span className="text-[10px] text-muted-foreground/70">last 24h</span>
      </div>

      <div className="-mx-3 md:mx-0 overflow-x-auto no-scrollbar">
        <div className="flex gap-2 px-3 md:px-0 min-w-max">
          {movers.map(m => <MoverCard key={`${m.engine}-${m.id}`} m={m} onOpen={() => router.push(m.href)} />)}
        </div>
      </div>
    </div>
  );
}

function MoverCard({ m, onOpen }: { m: Mover; onOpen: () => void }) {
  const up = m.deltaPct >= 0;

  // Flash the number when it changes between polls. This is the one moment
  // the page visibly moves on its own, and it is the whole point — a price
  // that ticks reads as live in a way a static percentage never does.
  const prev = useRef(m.pricePct);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (Math.abs(m.pricePct - prev.current) > 0.05) {
      setFlash(m.pricePct > prev.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 900);
      prev.current = m.pricePct;
      return () => clearTimeout(t);
    }
    prev.current = m.pricePct;
  }, [m.pricePct]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'shrink-0 w-52 text-left rounded-xl border p-3 space-y-2',
        'bg-card/70 backdrop-blur-sm transition-colors duration-150',
        'border-border/60 hover:border-emerald-500/40 active:border-emerald-500/60',
      )}
    >
      <p className="text-[11px] font-medium leading-snug line-clamp-2 min-h-[2.2em]">
        {m.question}
      </p>

      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className={cn(
            'text-xl font-bold tabular leading-none transition-colors duration-300',
            flash === 'up' ? 'text-emerald-300' : flash === 'down' ? 'text-red-300' : 'text-foreground',
          )}>
            {m.pricePct.toFixed(0)}%
          </div>
          <div className="text-[10px] text-muted-foreground truncate mt-0.5">{m.topOutcome}</div>
        </div>

        <div className={cn(
          'flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold shrink-0',
          up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300',
        )}>
          {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {up ? '+' : ''}{m.deltaPct.toFixed(1)}
        </div>
      </div>

      {/* Social proof line. Deliberately the last thing read and the reason to
          tap: what other people have put in is more persuasive than the
          question itself. */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground pt-0.5 border-t border-border/40">
        <span className="tabular">{ngnShort(m.poolTngn)}</span>
        {m.traders > 0 && (
          <span className="flex items-center gap-0.5">
            <Users className="w-2.5 h-2.5" />{m.traders}
          </span>
        )}
        {m.engine === 'trading' && (
          <span className="ml-auto text-emerald-400/70 font-medium">TRADE</span>
        )}
      </div>
    </button>
  );
}
