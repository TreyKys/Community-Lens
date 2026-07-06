'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { Search, X, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// Drives MarketList via URL params: ?q=..&sort=..&status=..
// Search is debounced (250ms) so we don't refire the query on every keystroke.
// Sort + status are pill-style buttons — single tap, no dropdown thrash.

const SORTS = [
  { id: 'new',     label: 'New' },
  { id: 'closing', label: 'Closing soon' },
  { id: 'pool',    label: 'Biggest pool' },
] as const;

const STATUSES = [
  { id: 'open',     label: 'Open' },
  { id: 'locked',   label: 'Locked' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all',      label: 'All' },
] as const;

export function MarketsToolbar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sort   = searchParams.get('sort')   || 'new';
  const status = searchParams.get('status') || 'open';
  const initialQ = searchParams.get('q') || '';

  const [q, setQ] = useState(initialQ);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    if (!v) next.delete(k);
    else next.set(k, v);
    router.push(`/markets?${next.toString()}`);
  };

  // Debounced search — fires URL update 250ms after the user stops typing.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q === initialQ) {
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      setParam('q', q.trim() ? q.trim() : null);
      setSearching(false);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="space-y-2.5">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search markets — try 'arsenal', 'naira', 'tinubu'…"
          className="w-full bg-card/50 border border-emerald-500/15 rounded-xl pl-9 pr-9 py-2.5 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:border-emerald-500/40 focus:bg-card transition-all"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {searching && <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
          {q && !searching && (
            <button
              type="button"
              onClick={() => setQ('')}
              className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Sort + Status pills, scrollable on mobile */}
      <div className="flex items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mr-1">Sort</span>
          {SORTS.map(s => (
            <button
              key={s.id}
              onClick={() => setParam('sort', s.id === 'new' ? null : s.id)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium border transition-colors whitespace-nowrap',
                sort === s.id
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                  : 'bg-transparent text-muted-foreground border-border/40 hover:border-border hover:text-foreground'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border/40 shrink-0" />

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mr-1">Status</span>
          {STATUSES.map(s => (
            <button
              key={s.id}
              onClick={() => setParam('status', s.id === 'open' ? null : s.id)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium border transition-colors whitespace-nowrap',
                status === s.id
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                  : 'bg-transparent text-muted-foreground border-border/40 hover:border-border hover:text-foreground'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
