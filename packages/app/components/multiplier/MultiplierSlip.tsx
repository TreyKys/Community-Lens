'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useSlip } from './SlipProvider';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Layers, X, Zap, Loader2, TrendingUp, Trash2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuoteResponse {
  ok: boolean;
  error?: string;
  detail?: string;
  legs?: { marketId: number; outcomeIndex: number; option: string; lockedOdds: number; open: boolean }[];
  combinedOdds?: number;
  payout?: number;
  netStake?: number;
  tier?: number;
  capBound?: boolean;
}

// Friendly copy for each validation reason the quote endpoint can return.
const REASON_COPY: Record<string, string> = {
  too_few_legs: 'Add at least 2 picks to build a Multiplier.',
  too_many_legs: 'Too many picks for this stake. Raise your stake or drop a pick.',
  duplicate_event: 'Only one pick per event.',
  leg_below_min_odds: 'One pick is too short-priced (min 1.20× each).',
  combined_below_min: 'Combined odds must reach 3.00×. Add a longer pick.',
  stake_below_min: 'Minimum stake is ₦100.',
};

export function MultiplierSlip() {
  const { legs, removeLeg, clear, isOpen, setOpen } = useSlip();
  const { toast } = useToast();

  const [stake, setStake] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [boosts, setBoosts] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);
  const [session, setSession] = useState<any>(null);

  const stakeNum = Number(stake);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Pull the Boost balance whenever the drawer opens.
  useEffect(() => {
    if (!isOpen || !session?.access_token) return;
    fetch('/api/multiplier/boosts', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(r => r.json())
      .then(d => { if (typeof d.balance === 'number') setBoosts(d.balance); })
      .catch(() => {});
  }, [isOpen, session?.access_token]);

  // Live quote — debounced on legs / stake change.
  useEffect(() => {
    if (legs.length === 0) { setQuote(null); return; }
    const s = stakeNum >= 100 ? stakeNum : 100; // preview at min if blank
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const res = await fetch('/api/multiplier/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slipStake: s, legs: legs.map(l => ({ marketId: l.marketId, outcomeIndex: l.outcomeIndex })) }),
        });
        const data = await res.json();
        setQuote(data);
      } catch {
        setQuote(null);
      } finally {
        setQuoting(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [legs, stakeNum]);

  // Merge the live leg odds into the displayed legs.
  const legOddsById = useMemo(() => {
    const m: Record<number, number> = {};
    (quote?.legs || []).forEach(l => { m[l.marketId] = l.lockedOdds; });
    return m;
  }, [quote]);

  const validStake = Number.isFinite(stakeNum) && stakeNum >= 100;
  const hasBoost = (boosts ?? 0) >= 1;
  const canPlace = !!session && validStake && quote?.ok && hasBoost && !placing;

  const placeSlip = async () => {
    if (!session?.access_token) {
      toast({ title: 'Sign in to place a Multiplier', variant: 'destructive' });
      return;
    }
    setPlacing(true);
    try {
      const res = await fetch('/api/multiplier/slip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ slipStake: stakeNum, legs: legs.map(l => ({ marketId: l.marketId, outcomeIndex: l.outcomeIndex })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not place Multiplier');
      toast({
        title: '🎯 Multiplier placed!',
        description: `${legs.length} picks at ${data.combinedOdds}× — ₦${Number(data.payout).toLocaleString()} if they all land.`,
      });
      if (typeof data.boostsRemaining === 'number') setBoosts(data.boostsRemaining);
      clear();
      setStake('');
      setOpen(false);
    } catch (e: any) {
      toast({ title: 'Multiplier failed', description: e.message, variant: 'destructive' });
    } finally {
      setPlacing(false);
    }
  };

  const buyBoost = async () => {
    if (!session?.access_token) {
      toast({ title: 'Sign in first', variant: 'destructive' });
      return;
    }
    setBuying(true);
    try {
      const res = await fetch('/api/multiplier/boosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ quantity: 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not buy a Boost');
      setBoosts(data.balance);
      toast({ title: 'Boost added', description: '₦70 deducted. You can place your Multiplier now.' });
    } catch (e: any) {
      toast({ title: 'Could not buy Boost', description: e.message, variant: 'destructive' });
    } finally {
      setBuying(false);
    }
  };

  // Floating launcher — only when there's a slip in progress.
  if (legs.length === 0) return null;

  return (
    <>
      {/* Floating launcher. Sits above the mobile bottom tab bar (h-16)
          and clear of the desktop edge. Soft violet so it reads as a
          distinct "special" surface next to the emerald singles flow. */}
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'fixed z-40 right-4 bottom-20 md:bottom-6 md:right-6',
          'flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full',
          'bg-gradient-to-r from-violet-500 to-indigo-500 text-white font-semibold text-sm',
          'shadow-lg shadow-violet-500/30 hover:shadow-violet-500/50 transition-all active:scale-95',
        )}
        aria-label="Open your Multiplier slip"
      >
        <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-white/20">
          <Layers className="w-3.5 h-3.5" />
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-violet-600 text-[10px] font-bold flex items-center justify-center">
            {legs.length}
          </span>
        </span>
        Multiplier
        {quote?.ok && quote.combinedOdds && (
          <span className="tabular-nums text-white/90">· {quote.combinedOdds.toFixed(2)}×</span>
        )}
      </button>

      <Drawer open={isOpen} onOpenChange={setOpen}>
        <DrawerContent className="max-h-[90vh] pb-[max(env(safe-area-inset-bottom),1.5rem)] border-violet-500/20">
          <div className="mx-auto w-full max-w-md flex flex-col flex-1 min-h-0">
            <DrawerHeader className="shrink-0">
              <DrawerTitle className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-violet-400" />
                Your Multiplier
                <span className="text-xs font-normal text-muted-foreground">({legs.length} {legs.length === 1 ? 'pick' : 'picks'})</span>
              </DrawerTitle>
              <DrawerDescription>Get every pick right to win them all.</DrawerDescription>
            </DrawerHeader>

            <div data-vaul-no-drag className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 space-y-3">
              {/* Legs */}
              <div className="space-y-2">
                {legs.map(leg => (
                  <div key={leg.marketId} className="flex items-center gap-2 rounded-lg border border-violet-500/15 bg-violet-500/[0.04] p-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{leg.marketQuestion}</p>
                      <p className="text-[11px] text-violet-300/90 mt-0.5">
                        {leg.optionLabel}
                        {legOddsById[leg.marketId] && (
                          <span className="tabular-nums text-muted-foreground"> · {legOddsById[leg.marketId].toFixed(2)}×</span>
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => removeLeg(leg.marketId)}
                      className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      aria-label="Remove pick"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {legs.length > 1 && (
                <button onClick={clear} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-red-400 transition-colors">
                  <Trash2 className="w-3 h-3" /> Clear all
                </button>
              )}

              {/* Stake */}
              <div className="space-y-1.5 pt-1">
                <label className="text-xs text-muted-foreground">Stake (₦)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    placeholder="Min ₦100"
                    value={stake}
                    onChange={e => setStake(e.target.value)}
                    min={100}
                    className="pl-8"
                  />
                </div>
                <div className="flex gap-1.5">
                  {[200, 500, 1000, 2000].map(v => (
                    <button
                      key={v}
                      onClick={() => setStake(String(v))}
                      className="text-[11px] px-2 py-1 rounded-md bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                    >
                      ₦{v.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Payout card */}
              <div className="rounded-xl border border-violet-500/25 bg-gradient-to-br from-violet-500/10 via-violet-500/[0.04] to-transparent p-3.5">
                {quoting ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> Pricing your slip…
                  </div>
                ) : quote?.ok ? (
                  <>
                    <div className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-[0.12em] text-violet-300/90 font-semibold">
                      <Sparkles className="w-3 h-3" /> If all {legs.length} land
                    </div>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-3xl font-black text-violet-300 tracking-tight tabular-nums leading-none">
                        {quote.combinedOdds?.toFixed(2)}×
                      </span>
                      <span className="text-sm text-violet-200/80 font-semibold tabular-nums">
                        ₦{Math.round(quote.payout || 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-violet-300/80">
                      <TrendingUp className="w-3 h-3 shrink-0" />
                      <span>Odds lock when you place. {quote.capBound ? 'Capped at the ₦200k max payout.' : 'Every leg must land.'}</span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-amber-300/90">
                    {quote?.error ? (REASON_COPY[quote.error] || quote.detail || 'Adjust your slip to continue.') : 'Add picks to see your odds.'}
                  </p>
                )}
              </div>

              {/* Boosts */}
              <div className="flex items-center justify-between rounded-lg bg-muted/30 border border-border/40 px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <Zap className="w-4 h-4 text-amber-400" />
                  <span>{boosts === null ? '—' : boosts} {boosts === 1 ? 'Boost' : 'Boosts'}</span>
                  <span className="text-[11px] text-muted-foreground">· 1 per slip</span>
                </div>
                {!hasBoost && (
                  <Button size="sm" variant="outline" onClick={buyBoost} disabled={buying} className="h-7 text-xs border-amber-500/30 text-amber-300 hover:bg-amber-500/10">
                    {buying ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Buy 1 · ₦70'}
                  </Button>
                )}
              </div>
            </div>

            {/* Place — pinned footer */}
            <div className="shrink-0 px-4 pt-3 pb-2">
              <Button
                onClick={placeSlip}
                disabled={!canPlace}
                className="w-full h-12 bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white font-semibold disabled:opacity-50"
              >
                {placing ? (
                  <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Placing…</span>
                ) : !session ? 'Sign in to place'
                  : !hasBoost ? 'Buy a Boost to place'
                  : !validStake ? 'Enter a stake'
                  : !quote?.ok ? 'Adjust your slip'
                  : `Place Multiplier · ₦${stakeNum.toLocaleString()}`}
              </Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
