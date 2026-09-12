import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { outcomeColorsFor, binaryYesIndex } from '@/lib/outcomeColors';

// The Open Markets browse card. Extracted from /open/page.tsx so every
// surface that lists trading-engine markets — the general /open browse list,
// any themed hub page like /bbn, and the /markets "Trade this category"
// rail — renders an identical card. Two implementations of "what a
// tradeable market looks like" drifting apart over time is exactly the kind
// of inconsistency a hub page is supposed to avoid, not create.
//
// The probability is the hero on every card — it's the one number that says
// what the crowd currently believes, and leading with it is what makes this
// read like a feed rather than a trading terminal.
//
// Every outcome gets its OWN color (lib/outcomeColors — the dataviz skill's
// validated categorical palette), not just "leader vs everyone else". A
// 2-outcome Yes/No card doesn't need it, but a BBN eviction with a dozen
// housemates used to render as one big number and a bar that was 90% flat
// grey — this is what actually fixed that, not a cosmetic pass.

export type OpenMarketCardRow = {
  id: string; question: string; category: string; outcomes: string[];
  prices: number[]; status: string; volumeTngn: number; horizonAt?: string | null;
};

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
// Legend rows are capped — a card is a feed item, not the detail page's full
// outcome list (which shows every one; see the Meter component on
// /open/[id]). Past this many, "+N more" is more legible than a wall of text.
const MAX_LEGEND_ROWS = 4;

export function OpenMarketCard({ market: m, hideCategory }: {
  market: OpenMarketCardRow;
  /** Hidden on hub pages where the category is implied by the page itself
      (every card on /bbn is already 'entertainment') — repeating it on
      every card is noise the visitor already knows. */
  hideCategory?: boolean;
}) {
  const top = m.prices.indexOf(Math.max(...m.prices));
  const colors = outcomeColorsFor(m.outcomes);
  const topColor = colors[top];
  const isBinary = m.outcomes.length === 2;
  // A recognised Yes/No book gets the two-ended treatment below: each side's
  // own price, printed at its own end of the bar, in its own color. Any other
  // shape — a fixture, a three-way, a 20-name eviction — keeps the ranked
  // legend it already had.
  const yesIdx = binaryYesIndex(m.outcomes);

  // Rank once, reuse for both the bar order (kept at outcome index — color
  // must never shuffle with price) and the legend (which DOES read better
  // sorted by size, since it's a "who's leading" summary, not an identity map).
  const ranked = m.prices
    .map((p, i) => ({ i, p }))
    .sort((a, b) => b.p - a.p);

  return (
    <Link href={`/open/${m.id}`} className="block">
      <Card className="transition-colors duration-150 hover:border-emerald-500/30 active:border-emerald-500/50 overflow-hidden relative">
        {/* A hairline top edge in the leading outcome's own color — the one
            thing that lets a scroll of ten cards read as ten DIFFERENT
            questions at a glance, before you've read a single word. */}
        <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: topColor }} />
        <CardContent className="p-4 pt-[18px] space-y-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium leading-snug">{m.question}</p>
            <div className="text-right shrink-0">
              <div className="text-2xl font-semibold tabular leading-none" style={{ color: topColor }}>
                {pct(m.prices[top])}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[7rem] truncate">{m.outcomes[top]}</div>
            </div>
          </div>

          {/* Segmented bar — every outcome, in outcome order, each in its own
              color. A 2px gap between fills (dataviz mark spec) instead of a
              hard seam — reads as distinct pieces of one whole, not a single
              bar that happens to change shade. min-w keeps a long-tail
              outcome's sliver visible instead of vanishing at sub-pixel width. */}
          <div className="flex h-2 w-full gap-0.5">
            {m.prices.map((p, i) => (
              <div key={i}
                   className="rounded-full min-w-[3px] transition-[width] duration-500 ease-out"
                   style={{ width: `${p * 100}%`, background: colors[i] }} />
            ))}
          </div>

          {/* Yes/No books get both sides priced, one at each end of the bar
              they belong to. The hero number above only ever names the
              leader; this is the line that says what the OTHER side costs,
              which is the number you need if you disagree with the crowd —
              and disagreeing with the crowd is the entire product. */}
          {yesIdx !== null && (
            <div className="flex items-center justify-between -mt-1.5 text-[11px] font-semibold tabular">
              <span style={{ color: colors[0] }}>
                {m.outcomes[0].toUpperCase()} {pct(m.prices[0])}
              </span>
              <span style={{ color: colors[1] }}>
                {pct(m.prices[1])} {m.outcomes[1].toUpperCase()}
              </span>
            </div>
          )}

          {/* Legend — skipped for a binary market, where the bar + hero
              number already say everything ("Yes 63%" implies "No 37%").
              For 3+ outcomes it's the piece that used to be missing
              entirely: you could see the LEADER but nothing else was named. */}
          {!isBinary && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ranked.slice(0, MAX_LEGEND_ROWS).map(({ i, p }) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colors[i] }} />
                  <span className="truncate max-w-[6rem]">{m.outcomes[i]}</span>
                  <span className="tabular text-foreground/70">{pct(p)}</span>
                </div>
              ))}
              {ranked.length > MAX_LEGEND_ROWS && (
                <span className="text-[10px] text-muted-foreground/70">
                  +{ranked.length - MAX_LEGEND_ROWS} more
                </span>
              )}
            </div>
          )}

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
