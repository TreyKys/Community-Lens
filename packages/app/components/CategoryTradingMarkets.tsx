'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { TrendingUp, ArrowRight } from 'lucide-react';
import { OpenMarketCard, type OpenMarketCardRow } from '@/components/OpenMarketCard';

// Which /markets category tabs have a matching open_markets.category, and
// what it is. Only tabs that route through /markets' own filter belong here
// — Sports and BBN have dedicated hub pages (/football, /bbn, ...) that
// already show their trading markets via event_tag, and Trending/New are
// cross-cutting feeds with no single category to match. Crypto has no entry
// because open_markets has no 'crypto' category to match it to (see
// allowed_categories in 20260807000100_open_markets_review.sql) — showing
// nothing here is honest; guessing a category would not be.
//
// "economy" maps to two open_markets categories because CategoryTabs' own
// "Everything Economy" tab is already the catch-all for finance + tech
// content on the locked-odds side (see the comment on CATEGORIES in
// Sidebar.tsx) — mirrored here so a market tagged category='technology'
// isn't invisible everywhere except /open.
const CATEGORY_MAP: Record<string, string[]> = {
  politics: ['politics'],
  economy: ['economy', 'technology'],
};

// Trade markets were built as their own clearly-labelled section ON hub
// pages (see BBNHub) rather than interleaved into the locked-odds list — a
// tradeable share and a fixed bet behave differently, and blurring that in
// one feed would mislead more than it would simplify. This component fixes
// a DIFFERENT problem: a trading market tagged with a real category
// (politics, economy...) used to be discoverable ONLY at /open, never by
// browsing that category here — which made "Trade" read as walled off from
// the rest of the site instead of one more way to back an opinion in the
// same category.
export function CategoryTradingMarkets() {
  const searchParams = useSearchParams();
  const category = searchParams.get('category') || 'trending';
  const cats = CATEGORY_MAP[category];

  const [rows, setRows] = useState<OpenMarketCardRow[]>([]);
  const [loading, setLoading] = useState(!!cats);

  useEffect(() => {
    if (!cats) { setRows([]); return; }
    let live = true;
    setLoading(true);
    fetch(`/api/open-markets?category=${encodeURIComponent(cats.join(','))}&limit=8`)
      .then(r => r.json())
      .then(d => { if (live) setRows(d.markets || []); })
      .catch(() => { if (live) setRows([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  if (!cats) return null;
  if (!loading && rows.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold">Trade this category</h2>
        </div>
        <Link href="/open" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          All trading markets <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1].map(i => <div key={i} className="h-28 rounded-xl shimmer" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(m => <OpenMarketCard key={m.id} market={m} hideCategory />)}
        </div>
      )}
    </section>
  );
}
