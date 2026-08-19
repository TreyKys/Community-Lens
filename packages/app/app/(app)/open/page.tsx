'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';

// Browse open markets. The probability is the hero on every card — it is the
// one number that says what the crowd currently believes, and leading with it
// is what makes this read like a feed rather than a trading terminal.

type Row = {
  id: string; question: string; category: string; outcomes: string[];
  prices: number[]; status: string; volumeTngn: number; horizonAt?: string;
};

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

export default function OpenMarketsPage() {
  const [rows, setRows] = useState<Row[]>([]);
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
      <div>
        <h1 className="text-xl font-bold">Open Markets</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Buy a share for what the crowd thinks it&rsquo;s worth. It pays ₦1 if it happens, ₦0 if it doesn&rsquo;t —
          and unlike a bet, you can sell any time instead of waiting for the answer.
        </p>
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
          <p className="text-sm font-medium">No open markets yet</p>
          <p className="text-xs text-muted-foreground">
            These are for questions without a fixed end date. The first ones land soon.
          </p>
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {rows.map(m => {
            const top = m.prices.indexOf(Math.max(...m.prices));
            return (
              <Link key={m.id} href={`/open/${m.id}`} className="block">
                <Card className="transition-colors duration-150 hover:border-emerald-500/30 active:border-emerald-500/50">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium leading-snug">{m.question}</p>
                      <div className="text-right shrink-0">
                        <div className="text-2xl font-semibold tabular leading-none">{pct(m.prices[top])}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{m.outcomes[top]}</div>
                      </div>
                    </div>

                    <div className="flex h-1 w-full rounded-full overflow-hidden bg-muted">
                      {m.prices.map((p, i) => (
                        <div key={i}
                             className={i === top ? 'bg-emerald-500' : 'bg-muted-foreground/30'}
                             style={{ width: `${p * 100}%` }} />
                      ))}
                    </div>

                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Badge variant="outline" className="text-[9px] px-1 py-0">{m.category}</Badge>
                      {m.status !== 'open' && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">{m.status}</Badge>
                      )}
                      {m.volumeTngn > 0 && <span>₦{m.volumeTngn.toLocaleString()} traded</span>}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
