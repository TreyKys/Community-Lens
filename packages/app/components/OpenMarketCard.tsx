import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// The Open Markets browse card. Extracted from /open/page.tsx so every
// surface that lists trading-engine markets — the general /open browse list,
// and any themed hub page like /bbn — renders an identical card. Two
// implementations of "what a tradeable market looks like" drifting apart
// over time is exactly the kind of inconsistency a hub page is supposed to
// avoid, not create.
//
// The probability is the hero on every card — it's the one number that says
// what the crowd currently believes, and leading with it is what makes this
// read like a feed rather than a trading terminal.

export type OpenMarketCardRow = {
  id: string; question: string; category: string; outcomes: string[];
  prices: number[]; status: string; volumeTngn: number; horizonAt?: string | null;
};

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

export function OpenMarketCard({ market: m, hideCategory }: {
  market: OpenMarketCardRow;
  /** Hidden on hub pages where the category is implied by the page itself
      (every card on /bbn is already 'entertainment') — repeating it on
      every card is noise the visitor already knows. */
  hideCategory?: boolean;
}) {
  const top = m.prices.indexOf(Math.max(...m.prices));
  return (
    <Link href={`/open/${m.id}`} className="block">
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
            {!hideCategory && <Badge variant="outline" className="text-[9px] px-1 py-0">{m.category}</Badge>}
            {m.status !== 'open' && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">{m.status}</Badge>
            )}
            {m.volumeTngn > 0 && <span>₦{m.volumeTngn.toLocaleString()} traded</span>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
