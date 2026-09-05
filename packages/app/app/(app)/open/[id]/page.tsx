'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { sharesForBudget } from '@/lib/lmsr';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, TrendingUp, TrendingDown, Info, Share2, Flag } from 'lucide-react';

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
//
// A third thing this screen is careful about, added alongside the meter/
// ticker/chart redesign below: the trade ticker shows SHARE counts, never
// naira. open_trades is owner-only at the RLS layer specifically because a
// public per-account wallet-size signal is a physical-safety problem on this
// platform (see the comment on open_trades_public_read in
// 20260806000000_open_markets_schema.sql) — delta_shares is the one size
// signal that migration deliberately made public via open_trades_tape, and
// that is the only thing this page shows per trade.

type Mkt = {
  id: string; question: string; description?: string; outcomes: string[];
  prices: number[]; q: number[]; b: number; status: string; resolutionSource: string;
  horizonAt?: string; tradingClosesAt?: string; resolvedOutcome?: number | null;
  volumeTngn: number; isCreator: boolean; settlementLockedUntil?: string | null;
};
type Tick = { outcomeIdx: number; price: number; shares: number; at: string };
type CtxItem = { title: string; body: string };
type Pos = { positionId: string; outcomeIdx: number; outcomeLabel: string;
  shares: number; costBasisTngn: number; markValueTngn: number; unrealisedPnlTngn: number };

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

function relTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function OpenMarketPage({ params }: { params: { id: string } }) {
  const { toast } = useToast();
  const [mkt, setMkt] = useState<Mkt | null>(null);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [history, setHistory] = useState<Tick[]>([]);
  const [loading, setLoading] = useState(true);
  const [disputing, setDisputing] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [outcomeIdx, setOutcomeIdx] = useState(0);
  // `amount` is always a SHARE count — it is what the quote and the trade RPC
  // take. On a buy the user types naira into `budget` and this is derived
  // from it; on a sell they size it directly.
  const [amount, setAmount] = useState('');
  const [budget, setBudget] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);

  // "More about this market" — fetched separately from the main load so a
  // slow or failed Gemini call never blocks or breaks the trading page.
  const [context, setContext] = useState<CtxItem[] | null>(null);
  const [contextLoading, setContextLoading] = useState(true);

  // Fires a brief glow/tick the moment a trade lands — the current user's own,
  // or anyone else's, picked up on the next poll. Compares against the
  // PREVIOUS prices seen, not just "did load() run", so a poll that finds
  // nothing new stays quiet.
  const [pulse, setPulse] = useState(false);
  const prevPricesRef = useRef<number[] | null>(null);

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

      const prev = prevPricesRef.current;
      if (prev && d.market.prices.some((p: number, i: number) => Math.abs(p - (prev[i] ?? p)) > 0.0005)) {
        setPulse(true);
        setTimeout(() => setPulse(false), 650);
      }
      prevPricesRef.current = d.market.prices;

      setMkt(d.market);
      setPositions(d.position || []);
      setHistory(d.priceHistory || []);
    } catch (e: any) {
      // Silent on a background poll — only the first, blocking load should
      // interrupt the user with a toast.
      if (loading) toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [params.id, toast, loading]);

  useEffect(() => { load(); }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for trades landing while nobody but this tab is watching — an
  // "immersive" market is one that visibly moves without the viewer having to
  // do anything. Paused when the tab isn't visible, and stops once the book
  // is no longer open.
  useEffect(() => {
    if (!mkt || mkt.status !== 'open') return;
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load();
    }, 15000);
    return () => clearInterval(id);
  }, [mkt?.status, load]);

  // "More about this market" — one fetch per market, cached server-side.
  useEffect(() => {
    let cancelled = false;
    setContextLoading(true);
    fetch(`/api/open-markets/${params.id}/context`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setContext(Array.isArray(d.items) ? d.items : []); })
      .catch(() => { if (!cancelled) setContext([]); })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [params.id]);

  // Naira in -> share count out, computed locally from the book. Debounced
  // alongside the quote so a fast typist doesn't churn it.
  //
  // This is an ESTIMATE used to size the order. The authoritative price comes
  // back from the quote endpoint below, and the order itself carries a limit,
  // so being slightly stale here can never produce a fill the user didn't
  // agree to.
  useEffect(() => {
    if (side !== 'buy') return;
    const naira = Number(budget);
    if (!mkt || !naira || naira <= 0) { if (side === 'buy') setAmount(''); return; }
    const t = setTimeout(() => {
      try {
        const n = sharesForBudget(mkt.q, mkt.b, outcomeIdx, naira);
        setAmount(n > 0 ? String(n) : '');
      } catch { setAmount(''); }
    }, 200);
    return () => clearTimeout(t);
  }, [budget, outcomeIdx, side, mkt]);

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
      setAmount(''); setBudget(''); setQuote(null);
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
  const shares = Number(amount) || 0;

  // A dispute only means anything while payouts are still held. Once money
  // lands in a withdrawable balance it cannot be taken back, so the button
  // disappears rather than becoming a promise we can't keep.
  const canDispute = positions.length > 0
    && ['pending_payout', 'resolved', 'voided'].includes(mkt.status)
    && !!mkt.settlementLockedUntil
    && new Date(mkt.settlementLockedUntil).getTime() > Date.now();

  const share = async () => {
    const url = `${window.location.origin}/open/${params.id}`;
    const text = `${mkt.question} — currently ${pct(mkt.prices[0])} ${mkt.outcomes[0]}`;
    try {
      // Web Share hands off to WhatsApp directly on a phone, which is where
      // this actually spreads. Clipboard is the desktop fallback.
      if (navigator.share) await navigator.share({ title: mkt.question, text, url });
      else {
        await navigator.clipboard.writeText(url);
        toast({ title: 'Link copied' });
      }
    } catch { /* user dismissed the sheet — not an error */ }
  };

  const raiseDispute = async () => {
    setDisputing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`/api/open-markets/${params.id}/dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ reason: disputeReason }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not raise this');
      toast({
        title: 'Sent to our team',
        description: 'Payouts on this market are held until someone reviews it.',
      });
      setDisputeOpen(false); setDisputeReason('');
    } catch (e: any) {
      toast({ title: 'Not sent', description: e.message, variant: 'destructive' });
    } finally { setDisputing(false); }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Link href="/open" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> All trading markets
        </Link>
        <button onClick={share}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Share2 className="w-3.5 h-3.5" /> Share
        </button>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-lg font-semibold leading-snug">{mkt.question}</h1>
            <Badge variant="outline" className="text-[10px] uppercase shrink-0">{mkt.status}</Badge>
          </div>
          {mkt.description && <p className="text-sm text-muted-foreground">{mkt.description}</p>}

          {/* Probability leads. A binary market gets the unified meter: Yes
              and No always sum to 100%, so two separate bars were the same
              number said twice. A market with more than two outcomes keeps
              the original per-outcome list — there is no single "favoured
              side" line to draw through more than two options. */}
          {mkt.outcomes.length === 2 ? (
            <Meter outcomes={mkt.outcomes} prices={mkt.prices}
                   selected={outcomeIdx} onSelect={setOutcomeIdx} pulse={pulse} />
          ) : (
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
                    <span className={`text-xl font-semibold tabular ${pulse ? 'market-tick' : ''}`}>{pct(mkt.prices[i])}</span>
                  </div>
                  <div className="mt-2 h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
                         style={{ width: `${mkt.prices[i] * 100}%` }} />
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Live trade feed. A quiet market otherwise reads as dead — this
              is the same data open_trades_tape already makes public (share
              count and direction, never naira or who), just surfaced. */}
          <TradeTicker history={history} outcomes={mkt.outcomes} />

          {/* Every trade records the price it left behind, so the history is
              already in the trade log — no candle table. A sparse line on a
              three-trade market is honest; smoothing it would invent movement
              that never happened. */}
          <PriceHistory history={history} outcomeIdx={outcomeIdx}
                        label={mkt.outcomes[outcomeIdx]} current={mkt.prices[outcomeIdx]} />

          <p className="text-[11px] text-muted-foreground pt-1">
            Resolves against <span className="text-foreground/80">{mkt.resolutionSource}</span>
            {mkt.horizonAt && <> · reviewed {new Date(mkt.horizonAt).toLocaleDateString()}</>}
          </p>
        </CardContent>
      </Card>

      {/* "More about this market" — general background on the SUBJECT,
          written once per market and cached. Never a prediction and never
          this platform's view on the outcome; see lib/openMarketContext.ts. */}
      <MarketContextPanel items={context} loading={contextLoading} />

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

            {/* BUY takes naira, not a share count.
                "Put ₦2,000 on Yes" is how someone actually thinks, and every
                other staking flow on this site asks for naira. Asking for
                shares makes the user do the market maker's arithmetic before
                they can place a bet. The share count is derived and shown
                underneath, so nothing is hidden — it is just no longer the
                thing you have to work out yourself.

                SELL stays in shares, sized off the holding, because there the
                natural question is "how much of my position do I want out
                of" — and a naira target is not answerable in advance, since
                the proceeds depend on how far your own sale moves the price. */}
            {side === 'buy' ? (
              <div className="space-y-2">
                <label className="text-[11px] text-muted-foreground">
                  How much on <span className="text-foreground/80">{mkt.outcomes[outcomeIdx]}</span>?
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
                  <Input type="number" inputMode="numeric" placeholder="Amount (min ₦100)"
                         className="pl-8 bg-transparent" min={100}
                         value={budget} onChange={e => setBudget(e.target.value)} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[500, 1000, 2000, 5000].map(v => (
                    <button key={v} type="button"
                            onClick={() => setBudget(String(v))}
                            className={`px-2.5 py-1 rounded-full border text-[11px] transition-colors duration-150 ${
                              Number(budget) === v
                                ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                                : 'border-border/60 text-muted-foreground hover:border-emerald-500/40'}`}>
                      ₦{v.toLocaleString()}
                    </button>
                  ))}
                </div>
                {Number(budget) > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {shares > 0
                      ? <>That buys about <span className="text-foreground/80 tabular">{shares.toLocaleString()}</span> shares
                          at today&rsquo;s price.</>
                      : 'Too small to place — try at least ₦100.'}
                  </p>
                )}
              </div>
            ) : (
            <div className="space-y-2">
              <label className="text-[11px] text-muted-foreground">
                Sell <span className="text-foreground/80">{mkt.outcomes[outcomeIdx]}</span>
                {held && <> · you hold {Math.round(held.shares).toLocaleString()}</>}
              </label>
              <Input type="number" inputMode="numeric" placeholder="Shares to sell"
                     value={amount} onChange={e => setAmount(e.target.value)} />
              <div className="flex flex-wrap gap-1.5">
                {[25, 50, 100].map(p => (
                  <button key={p} type="button"
                          disabled={!held}
                          onClick={() => held && setAmount(String(Math.floor(held.shares * p / 100)))}
                          className="px-2.5 py-1 rounded-full border border-border/60 text-[11px] text-muted-foreground hover:border-red-500/40 disabled:opacity-40">
                    {p === 100 ? 'All' : `${p}%`}
                  </button>
                ))}
              </div>
            </div>
            )}
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

                {/* The number people actually came for. Each share pays ₦1 if
                    this outcome happens, so the payout is just the share
                    count — but nobody should have to work that out, and
                    stating the profit separately is what makes the trade
                    legible at a glance. */}
                {side === 'buy' && (
                  <div className="pt-2 mt-1 border-t border-border/50 space-y-1">
                    <Row label={`If ${mkt.outcomes[outcomeIdx]} happens, you get`}
                         value={ngn(Number(amount) || 0)} strong />
                    <Row label="That's a profit of"
                         value={`${ngn(Math.max(0, (Number(amount) || 0) - Math.abs(quote.totalTngn)))}`} />
                    <Row label="If it doesn't happen" value="₦0" muted />
                  </div>
                )}

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

      {/* Only while payouts are still held. After release there is nothing
          left to hold back, so offering the button would be offering
          something we cannot do. */}
      {canDispute && (
        <Card className="border-border/60">
          <CardContent className="p-4 space-y-2">
            {!disputeOpen ? (
              <>
                <button onClick={() => setDisputeOpen(true)}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <Flag className="w-3.5 h-3.5" /> Think this result is wrong?
                </button>
                <p className="text-[10px] text-muted-foreground">
                  Payouts are held until {new Date(mkt.settlementLockedUntil!).toLocaleString()}.
                  Raising this before then pauses them while a person checks.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium">What&rsquo;s wrong with this result?</p>
                <textarea
                  className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[64px]"
                  placeholder="Tell us what you think the right answer is, and why."
                  value={disputeReason} onChange={e => setDisputeReason(e.target.value)} />
                <div className="grid grid-cols-2 gap-2">
                  <Button size="sm" variant="outline" disabled={disputing}
                          onClick={() => { setDisputeOpen(false); setDisputeReason(''); }}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={disputing || disputeReason.trim().length < 15}
                          onClick={raiseDispute}>
                    {disputing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send'}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// The tug-of-war meter for a binary (exactly two outcome) market.
//
// Yes and No always sum to 100%, so two identical progress bars were the
// same number said twice. This is one bar, split where the book actually
// is, with one big reactive digit for whichever side is currently favoured.
// Outcome order is always [0, 1] left-to-right and never swaps sides as the
// price crosses 50% — only the FILL colour (emerald for whichever is
// favoured, muted for the other) moves, so the layout never jumps.
function Meter({ outcomes, prices, selected, onSelect, pulse }: {
  outcomes: string[]; prices: number[]; selected: number; onSelect: (i: number) => void; pulse: boolean;
}) {
  const leadIdx = prices[0] >= prices[1] ? 0 : 1;

  return (
    <div className="pt-1">
      <div className="text-center pb-2">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{outcomes[leadIdx]}</span> is currently favoured
        </p>
        <p className={`text-4xl font-bold tabular tracking-tight text-emerald-400 ${pulse ? 'market-tick' : ''}`}>
          {pct(prices[leadIdx])}
        </p>
      </div>

      <div className={`relative h-9 rounded-lg border border-border overflow-hidden flex bg-muted/50 ${pulse ? 'market-bar-glow' : ''}`}>
        {[0, 1].map(i => (
          <button
            key={i}
            onClick={() => onSelect(i)}
            aria-label={`Trade ${outcomes[i]}, currently ${pct(prices[i])}`}
            className={`h-full flex items-center text-[11px] font-semibold overflow-hidden transition-[width] duration-500 ease-out ${
              i === 0 ? 'justify-end pr-2 border-r border-background/40' : 'justify-start pl-2'
            } ${
              i === leadIdx ? 'bg-emerald-500 text-emerald-950' : 'bg-muted text-muted-foreground'
            } ${selected === i ? 'ring-2 ring-inset ring-emerald-400/70' : ''}`}
            style={{ width: `${Math.max(prices[i] * 100, 2)}%` }}
          >
            {prices[i] > 0.13 && pct(prices[i])}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground pt-1 tabular">
        <span>{outcomes[0]} · {pct(prices[0])}</span>
        <span>{outcomes[1]} · {pct(prices[1])}</span>
      </div>
    </div>
  );
}

// Live trade feed. Same tape data open_trades_tape already exposes publicly
// — direction and share size, never naira and never who — just surfaced
// instead of sitting unused in the price-history array.
function TradeTicker({ history, outcomes }: { history: Tick[]; outcomes: string[] }) {
  if (history.length === 0) return null;
  const rows = [...history]
    .sort((a, b) => +new Date(b.at) - +new Date(a.at))
    .slice(0, 6);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 market-live-dot" />
        Recent trades
      </div>
      <div>
        {rows.map(t => (
          <div key={`${t.at}_${t.outcomeIdx}_${t.shares}`}
               className="market-row-in flex items-center justify-between px-3 py-1.5 text-xs border-b border-border/60 last:border-0">
            <span className="text-muted-foreground">
              {t.shares > 0 ? 'Bought' : 'Sold'} <span className="text-foreground/80">{outcomes[t.outcomeIdx]}</span>
            </span>
            <span className="flex items-center gap-2 tabular">
              <span className="font-medium">{Math.round(Math.abs(t.shares)).toLocaleString()} shares</span>
              <span className="text-muted-foreground">{relTime(t.at)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// "More about this market" — general background on the SUBJECT, never the
// outcome. Reuses the same card language as everything else on this page;
// the diamond marks are just a quiet visual rhythm down the list, not a
// sequence (there is no order to these — any could stand alone).
function MarketContextPanel({ items, loading }: { items: CtxItem[] | null; loading: boolean }) {
  if (!loading && (!items || items.length === 0)) return null;
  const marks = ['◐', '◑', '◒', '◓'];

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          More about this market
        </p>
        {loading ? (
          <div className="space-y-2 pt-3">
            <div className="h-3 w-2/3 rounded shimmer" />
            <div className="h-3 w-full rounded shimmer" />
            <div className="h-3 w-5/6 rounded shimmer" />
          </div>
        ) : (
          <>
            <div className="pt-1">
              {items!.map((it, i) => (
                <div key={i} className={`grid grid-cols-[18px_1fr] gap-2.5 py-2.5 ${i > 0 ? 'border-t border-border/60' : ''}`}>
                  <span className="text-emerald-500/70 text-sm leading-6" aria-hidden>{marks[i % marks.length]}</span>
                  <div>
                    <p className="text-sm font-medium">{it.title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{it.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground pt-2 border-t border-border/60 mt-1">
              General background, written by AI — not a prediction, and not this platform&rsquo;s view on how it resolves.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Price history, drawn straight from the trade log.
//
// Deliberately no smoothing and no interpolation between trades: this is a
// market that may have had four trades all week, and a curve drawn through
// four points implies continuous movement that never happened. Flat segments
// between real trades are the truth — the gradient fill and hover tooltip
// added here change how much weight that honest line carries, not what it
// claims.
function PriceHistory({ history, outcomeIdx, label, current }: {
  history: Tick[]; outcomeIdx: number; label: string; current: number;
}) {
  const [tip, setTip] = useState<{ left: number; top: number; text: string } | null>(null);
  const points = history.filter(h => h.outcomeIdx === outcomeIdx);

  // One trade is a dot, not a line. Below that there is nothing to show, and
  // an empty chart frame reads as a loading failure.
  if (points.length < 2) {
    return (
      <p className="text-[10px] text-muted-foreground pt-1">
        Not enough trading yet to show how {label} has moved.
      </p>
    );
  }

  const W = 100, H = 32;
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const lo = Math.min(...points.map(p => p.price));
  const hi = Math.max(...points.map(p => p.price));
  // A flat market must not divide by zero, and it should draw as a flat line
  // through the middle rather than pinned to an edge.
  const span = hi - lo < 0.02 ? 0.02 : hi - lo;
  const mid = (hi + lo) / 2;
  const y = (p: number) => H - ((p - (mid - span / 2)) / span) * H;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(2)},${y(p.price).toFixed(2)}`).join(' ');
  const area = `${line} L${xs[xs.length - 1].toFixed(2)},${H} L${xs[0].toFixed(2)},${H} Z`;
  const first = points[0].price;
  const up = current >= first;
  const color = up ? '#10b981' : '#ef4444';
  const gradId = `open-mkt-grad-${outcomeIdx}`;
  const lastX = xs[xs.length - 1];
  const lastY = y(points[points.length - 1].price);

  const onMove = (e: any) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let nearestI = 0, best = Infinity;
    xs.forEach((x, i) => { const d = Math.abs(x - mx); if (d < best) { best = d; nearestI = i; } });
    setTip({
      left: (xs[nearestI] / W) * rect.width,
      top: (y(points[nearestI].price) / H) * rect.height,
      text: `${(points[nearestI].price * 100).toFixed(1)}%`,
    });
  };

  return (
    <div className="pt-1 space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{label} over time</span>
        <span className={`tabular ${up ? 'text-emerald-400' : 'text-red-400'}`}>
          {up ? '▲' : '▼'} {Math.abs((current - first) * 100).toFixed(1)} pts
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
             className="w-full h-12" role="img"
             onMouseMove={onMove} onMouseLeave={() => setTip(null)}
             aria-label={`${label} moved from ${(first * 100).toFixed(0)}% to ${(current * 100).toFixed(0)}%`}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} stroke="none" />
          <path d={line} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                className={up ? 'stroke-emerald-500' : 'stroke-red-500'}
                strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={lastX} cy={lastY} r={4} fill={color} fillOpacity={0.4}
                  className="market-dot-ping" style={{ transformBox: 'fill-box', transformOrigin: 'center' } as any} />
          <circle cx={lastX} cy={lastY} r={1.8} fill={color} />
        </svg>
        {tip && (
          <div className="absolute pointer-events-none text-[10px] font-medium bg-popover border border-border rounded px-1.5 py-0.5 shadow-sm tabular z-10"
               style={{ left: tip.left, top: tip.top, transform: 'translate(-50%, -135%)' }}>
            {tip.text}
          </div>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {points.length} trade{points.length === 1 ? '' : 's'} · flat stretches are real, not missing data
      </p>
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
