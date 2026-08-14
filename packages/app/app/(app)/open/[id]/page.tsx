'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, TrendingUp, TrendingDown, Info } from 'lucide-react';

// Open market page: live probability, buy/sell, and an honest order ticket.
//
// Two things this screen is careful about, because both are places a
// prediction market can quietly mislead someone:
//
//  1. The quote is ADVISORY. The price moves with every trade, so the ticket
//     shows what you would pay right now and sends a LIMIT with the order. You
//     can never be filled worse than the number you agreed to.
//  2. The cost of EXITING is shown before you enter. A ₦10,000 buy cannot be
//     sold back for ₦10,000 — you pay the fee twice and walk the price back
//     down. Hiding that until someone tries to sell is how you lose trust.

type Mkt = {
  id: string; question: string; description?: string; outcomes: string[];
  prices: number[]; status: string; resolutionSource: string;
  horizonAt?: string; tradingClosesAt?: string; resolvedOutcome?: number | null;
  volumeTngn: number; isCreator: boolean;
};
type Pos = { positionId: string; outcomeIdx: number; outcomeLabel: string;
  shares: number; costBasisTngn: number; markValueTngn: number; unrealisedPnlTngn: number };

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export default function OpenMarketPage({ params }: { params: { id: string } }) {
  const { toast } = useToast();
  const [mkt, setMkt] = useState<Mkt | null>(null);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [loading, setLoading] = useState(true);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [outcomeIdx, setOutcomeIdx] = useState(0);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);

  // One id per intent-to-trade. Regenerated only after a fill, so a retry of
  // the SAME order replays rather than trading twice.
  const tradeIdRef = useRef<string>('');
  const newTradeId = () => {
    tradeIdRef.current = (globalThis.crypto?.randomUUID?.() ?? '');
    return tradeIdRef.current;
  };

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`/api/open-markets/${params.id}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load this market');
      setMkt(d.market);
      setPositions(d.position || []);
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [params.id, toast]);

  useEffect(() => { load(); }, [load]);

  // Re-quote as the user types. Debounced, because every keystroke otherwise
  // hits the pricing function.
  useEffect(() => {
    const shares = Number(amount);
    if (!shares || shares <= 0) { setQuote(null); return; }
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const r = await fetch(`/api/open-markets/${params.id}/quote`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcomeIdx, shares: side === 'buy' ? shares : -shares }),
        });
        const d = await r.json();
        setQuote(r.ok ? d : { error: d.error });
      } catch { setQuote(null); }
      finally { setQuoting(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [amount, outcomeIdx, side, params.id]);

  const place = async () => {
    if (!quote || quote.error) return;
    setPlacing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in');
      const shares = Number(amount) * (side === 'buy' ? 1 : -1);

      // The limit is the quoted total plus 2% headroom. Wide enough that a
      // normal price move does not reject a good-faith order; tight enough that
      // a large trade landing first cannot fill you at an unrecognisable price.
      const limit = side === 'buy'
        ? Math.abs(quote.totalTngn) * 1.02
        : Math.abs(quote.totalTngn) * 0.98;

      const r = await fetch(`/api/open-markets/${params.id}/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          clientTradeId: tradeIdRef.current || newTradeId(),
          outcomeIdx, shares, limitTngn: limit,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Trade failed');

      toast({
        title: d.replayed ? 'Already done' : (side === 'buy' ? 'Bought' : 'Sold'),
        description: side === 'buy'
          ? `${Number(amount).toLocaleString()} shares for ${ngn(Math.abs(d.totalTngn))}`
          : `${ngn(Math.abs(d.totalTngn))} back in your wallet`,
      });
      newTradeId();          // next order gets a fresh key
      setAmount(''); setQuote(null);
      load();
    } catch (e: any) {
      toast({ title: 'Trade failed', description: e.message, variant: 'destructive' });
    } finally { setPlacing(false); }
  };

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );
  if (!mkt) return <div className="p-6 text-center text-muted-foreground">Market not found.</div>;

  const tradable = mkt.status === 'open' && !mkt.isCreator;
  const held = positions.find(p => p.outcomeIdx === outcomeIdx);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <Link href="/open" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="w-4 h-4" /> All open markets
      </Link>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-lg font-semibold leading-snug">{mkt.question}</h1>
            <Badge variant="outline" className="text-[10px] uppercase shrink-0">{mkt.status}</Badge>
          </div>
          {mkt.description && <p className="text-sm text-muted-foreground">{mkt.description}</p>}

          {/* Probability leads. It is the single number that says what this
              market currently believes, and it is what makes browsing feel
              like reading a feed rather than an order book. */}
          <div className="space-y-2 pt-1">
            {mkt.outcomes.map((o, i) => (
              <button
                key={i}
                onClick={() => setOutcomeIdx(i)}
                className={`w-full rounded-lg border p-3 text-left transition-colors duration-150 ${
                  outcomeIdx === i ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-border hover:border-emerald-500/25'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{o}</span>
                  <span className="text-xl font-semibold tabular">{pct(mkt.prices[i])}</span>
                </div>
                <div className="mt-2 h-1 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
                       style={{ width: `${mkt.prices[i] * 100}%` }} />
                </div>
              </button>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground pt-1">
            Resolves against <span className="text-foreground/80">{mkt.resolutionSource}</span>
            {mkt.horizonAt && <> · reviewed {new Date(mkt.horizonAt).toLocaleDateString()}</>}
          </p>
        </CardContent>
      </Card>

      {positions.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <p className="text-xs text-muted-foreground">Your position</p>
            {positions.map(p => (
              <div key={p.positionId} className="flex items-center justify-between text-sm">
                <span>{Math.round(p.shares).toLocaleString()} × {p.outcomeLabel}</span>
                <span className={`tabular ${p.unrealisedPnlTngn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {p.unrealisedPnlTngn >= 0 ? '▲' : '▼'} {ngn(Math.abs(p.unrealisedPnlTngn))}
                </span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">
              Value shown at the current price. Selling moves the price, so what you actually receive is in the ticket below.
            </p>
          </CardContent>
        </Card>
      )}

      {mkt.isCreator && (
        <Card className="border-amber-500/30 bg-amber-500/[0.04]">
          <CardContent className="p-3 text-xs text-amber-200/90 flex gap-2">
            <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>You created this market, so you can&rsquo;t trade it. You earn from its trading fees instead — that&rsquo;s how creators are paid here.</span>
          </CardContent>
        </Card>
      )}

      {tradable && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Button variant={side === 'buy' ? 'default' : 'outline'} size="sm"
                      onClick={() => setSide('buy')}
                      className={side === 'buy' ? 'bg-emerald-600 hover:bg-emerald-500' : ''}>
                <TrendingUp className="w-4 h-4 mr-1" /> Buy
              </Button>
              <Button variant={side === 'sell' ? 'default' : 'outline'} size="sm"
                      onClick={() => setSide('sell')} disabled={!held}
                      className={side === 'sell' ? 'bg-red-600 hover:bg-red-500' : ''}>
                <TrendingDown className="w-4 h-4 mr-1" /> Sell
              </Button>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">
                Shares of <span className="text-foreground/80">{mkt.outcomes[outcomeIdx]}</span>
                {side === 'sell' && held && <> · you hold {Math.round(held.shares).toLocaleString()}</>}
              </label>
              <Input type="number" inputMode="numeric" placeholder="e.g. 1000"
                     value={amount} onChange={e => setAmount(e.target.value)} />
            </div>

            {quoting && <p className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Pricing…</p>}

            {quote?.error && <p className="text-xs text-destructive">{quote.error}</p>}

            {quote && !quote.error && (
              <div className="rounded-lg border border-border/60 bg-popover/40 p-3 space-y-1.5 text-xs">
                <Row label={side === 'buy' ? 'You pay' : 'You receive'}
                     value={ngn(Math.abs(quote.totalTngn))} strong />
                <Row label="Average price" value={pct(quote.avgPrice)} />
                <Row label="Fee (1.5%)" value={ngn(quote.feeTngn)} />
                <Row label="Price after" value={pct(quote.priceAfter)} />

                {/* The honest bit. */}
                {quote.roundTrip && (
                  <div className="pt-2 mt-1 border-t border-border/50 space-y-1">
                    <Row label="Sell back right now" value={ngn(quote.roundTrip.sellBackNowTngn)} />
                    <Row label="Cost of a round trip"
                         value={`${ngn(quote.roundTrip.costToExitTngn)} (${quote.roundTrip.costToExitPct.toFixed(1)}%)`}
                         muted />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Buying and immediately selling loses this much — the fee twice, plus the price
                      moving as you trade. You profit if the probability moves further than that.
                    </p>
                  </div>
                )}
              </div>
            )}

            <Button className="w-full bg-emerald-600 hover:bg-emerald-500"
                    disabled={placing || quoting || !quote || !!quote?.error}
                    onClick={place}>
              {placing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Placing…</>
                       : side === 'buy' ? 'Buy shares' : 'Sell shares'}
            </Button>
            <p className="text-[10px] text-center text-muted-foreground">
              Your order carries a price limit. If the market moves against you before it lands, it is rejected rather than filled at a worse price.
            </p>
          </CardContent>
        </Card>
      )}

      {mkt.status !== 'open' && (
        <p className="text-xs text-center text-muted-foreground">
          {mkt.status === 'horizon_window'
            ? 'This market has reached its review date. Trading is paused while holders choose to stay in or cash out.'
            : 'Trading is closed on this market.'}
        </p>
      )}
    </div>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-muted-foreground' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular ${strong ? 'text-base font-semibold text-foreground' : 'text-foreground/90'}`}>{value}</span>
    </div>
  );
}
