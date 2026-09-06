'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { OpenMarketCard, type OpenMarketCardRow } from '@/components/OpenMarketCard';
import { TradeHeroBackdrop } from '@/components/TradeHeroBackdrop';

// Browse open markets. Card rendering lives in OpenMarketCard so this stays
// in sync with any hub page (e.g. /bbn) that also lists trading-engine
// markets — see that component for why it was extracted.

export default function OpenMarketsPage() {
  const [rows, setRows] = useState<OpenMarketCardRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/open-markets')
      .then(r => r.json())
      .then(d => setRows(d.markets || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      {/* The one hero on this page — "TRADE" is the whole pitch for this
          engine over the rest of the site: everywhere else you place a bet
          and wait, here you can change your mind and sell. Sized and
          weighted to read as the headline, not a section label. */}
      <div className="relative overflow-hidden rounded-xl border border-emerald-500/15 bg-emerald-500/[0.03] px-4 pt-5 pb-4">
        <TradeHeroBackdrop />
        <div className="relative">
          <h1 className="text-4xl font-extrabold tracking-tight text-foreground">
            TRADE<span className="text-emerald-400">.</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-2 max-w-sm">
            Buy a share for what the crowd thinks it&rsquo;s worth. It pays ₦1 if it happens, ₦0 if it doesn&rsquo;t —
            and unlike a bet, you can sell any time instead of waiting for the answer.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="rounded-xl border border-border/60 p-4 space-y-3">
              <div className="h-4 w-3/4 rounded shimmer" />
              <div className="h-8 w-full rounded shimmer" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card><CardContent className="p-8 text-center space-y-2">
          <p className="text-sm font-medium">Nothing trading yet</p>
          <p className="text-xs text-muted-foreground">
            These are for questions without a fixed end date. The first ones land soon.
          </p>
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {rows.map(m => <OpenMarketCard key={m.id} market={m} />)}
        </div>
      )}
    </div>
  );
}
