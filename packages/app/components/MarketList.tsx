'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Drawer, DrawerContent, DrawerTrigger, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from '@/components/ui/drawer';
import { useToast } from '@/hooks/use-toast';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2, Lock, TrendingUp, Clock, CheckCircle2, ExternalLink, Info, ChevronDown, Sparkles, AlertTriangle, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { calculatePotentialPayout } from '@/lib/payout';
import { displayFloorPayout } from '@/lib/displayMultiplier';
import { calculateLockedOdds } from '@/lib/lockedOdds';
import { useSlip } from '@/components/multiplier/SlipProvider';
import { SharePickModal } from '@/components/SharePickModal';
import { PickPreviewModal } from '@/components/PickPreviewModal';
import { getDisplayPool } from '@/lib/displayPool';

interface Market {
  id: number;
  title: string;
  question: string;
  category: string;
  options: string[];
  status: 'open' | 'locked' | 'resolved' | 'voided';
  closes_at: string;
  total_pool: number;
  resolved_outcome: number | null;
  parent_market_id: number | null;
  on_chain_market_id: number | null;
  merkle_root: string | null;
  description: string | null;
  resolved_at: string | null;
  is_trending: boolean;
  trending_rank: number | null;
  is_locked_odds?: boolean;
  published_at?: string | null;
}

interface MarketCardProps {
  market: Market;
  session: any;
  onBetPlaced: (marketId: number, betId?: string) => void;
  hideViewMore?: boolean;
  isStaked?: boolean;
  /** OPx Picks prefill — set when an invitee landed here from /p/bet/[id]. */
  prefillOutcomeIndex?: number;
  prefillStakeTngn?: number;
  /** When true the stake input opens blank (Make-It-Yours flow). */
  prefillEditStake?: boolean;
  /** The shared bet/slip id this stake originated from, so the server can
   *  notify the original sharer. Passed straight through to the API. */
  prefillFromShareId?: string;
  /** Auto-open the bet drawer on mount. */
  autoOpen?: boolean;
}

// Color coding by option type — Polymarket style
function getOptionStyle(opt: string) {
  const o = opt.toLowerCase();
  if (o.includes('yes') || o.includes('home') || o.includes('win') || o.includes('over')) {
    return 'hover:border-blue-500/30 hover:bg-blue-500/5 aria-[selected=true]:bg-blue-500/15 aria-[selected=true]:border-blue-500/60';
  }
  if (o.includes('no') || o.includes('away') || o.includes('lose') || o.includes('under')) {
    return 'hover:border-red-500/30 hover:bg-red-500/5 aria-[selected=true]:bg-red-500/15 aria-[selected=true]:border-red-500/60';
  }
  // Draw / neutral
  return 'hover:border-amber-500/30 hover:bg-amber-500/5 aria-[selected=true]:bg-amber-500/15 aria-[selected=true]:border-amber-500/60';
}

function BettingInterface({
  market,
  session,
  onSuccess,
  onCancel,
  prefillOutcomeIndex,
  prefillStakeTngn,
  prefillFromShareId,
}: {
  market: Market;
  session: any;
  onSuccess: (betId?: string) => void;
  onCancel?: () => void;
  /** OPx Picks "Stake as is" / "Make It Yours" prefill */
  prefillOutcomeIndex?: number;
  prefillStakeTngn?: number;
  /** Shared bet/slip id this stake came from — threaded to /api/bet so
   *  the server can notify the original sharer. */
  prefillFromShareId?: string;
}) {
  const [selectedOption, setSelectedOption] = useState(
    prefillOutcomeIndex !== undefined ? String(prefillOutcomeIndex) : '',
  );
  const [amount, setAmount] = useState(
    prefillStakeTngn !== undefined && prefillStakeTngn > 0
      ? String(Math.round(prefillStakeTngn))
      : '',
  );
  // OPx Picks preview — shown in a small modal when the user taps the
  // "Preview your OPx Pick" button. State lives here so the parent
  // doesn't have to know about it.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [userHandle, setUserHandle] = useState<string | null>(null);
  useEffect(() => {
    if (!session?.user?.id) return;
    let alive = true;
    supabase.from('users').select('username, first_name').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (alive) setUserHandle((data?.username || data?.first_name || null) as string | null);
      });
    return () => { alive = false; };
  }, [session?.user?.id]);
  const [isLoading, setIsLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [distribution, setDistribution] = useState<{ option: string; amount: number; percentage: number }[]>([]);
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  // Multiplier slip — add the selected leg to the global slip.
  const { addLeg, hasMarket: slipHasMarket, setOpen: setSlipOpen } = useSlip();
  // Locked-odds config for this market, fetched alongside the
  // distribution. Null = parimutuel market (the legacy default), in
  // which case the parimutuel preview below applies unchanged.
  const [lockedConfig, setLockedConfig] = useState<{
    isLockedOdds: boolean;
    seedPool: number[];
    category: string;
    vigPct: number | null;
    reserve: { deployableTngn: number; floorTngn: number };
  } | null>(null);
  const { toast } = useToast();

  // First-bet parimutuel primer. Most "I don't get it" complaints die after
  // a single plain-language explainer; we gate via localStorage so it never
  // re-shows even if the user backs out without staking. Versioned key so
  // we can re-show on copy revisions if we ever need to.
  useEffect(() => {
    try {
      if (!localStorage.getItem('opinionsng_seen_walkthrough_v1')) {
        setShowWalkthrough(true);
      }
    } catch {}
  }, []);

  const dismissWalkthrough = () => {
    try { localStorage.setItem('opinionsng_seen_walkthrough_v1', new Date().toISOString()); } catch {}
    setShowWalkthrough(false);
  };

  // Per-option net pools used by the potential-winnings calculator.
  // Kept in sync with the bet distribution fetched below.
  const pools = market.options.map((_, i) => distribution[i]?.amount ?? 0);
  const stakeNum = Number(amount);
  const isLockedMarket = !!lockedConfig?.isLockedOdds;

  // Locked-odds preview. Runs the SAME canonical algorithm the server
  // uses (lib/lockedOdds) on the seed pool + live distribution, so the
  // range we show matches what gets frozen on the bet row. Only active
  // on locked-odds markets; parimutuel markets fall through to the
  // legacy preview below.
  const lockedPreview = (isLockedMarket && selectedOption !== '' && stakeNum >= 100 && lockedConfig)
    ? (() => {
        try {
          return calculateLockedOdds(
            {
              category: lockedConfig.category,
              seedPool: lockedConfig.seedPool,
              realPool: lockedConfig.seedPool.map((_, i) => pools[i] ?? 0),
              vigPctOverride: lockedConfig.vigPct ?? undefined,
            },
            stakeNum,
            parseInt(selectedOption),
            {},
            lockedConfig.reserve,
          );
        } catch {
          return null;
        }
      })()
    : null;

  // Parimutuel preview — legacy path, untouched for non-locked markets.
  const payoutPreview = (!isLockedMarket && selectedOption !== '' && stakeNum >= 100)
    ? calculatePotentialPayout(stakeNum, pools, parseInt(selectedOption))
    : null;

  // Break-even stake = the largest amount where multiplier stays >= 1.0.
  // Derived from the parimutuel payout identity (see lib/payout.ts) by
  // solving payout(s) = s for the prospective stake s with current pools
  // O (selected outcome) and L (losing side). Closed form:
  //   s* = (0.9·(1-r)·L - (1 - 0.9·(1-r))·O) / (1 - 0.9·(1-r))
  // where r is the entry rake. If the result is < 100 the market is
  // effectively un-bet-able profitably right now (suggestedMaxStake is
  // null in that case so we render a softer message).
  const suggestedMaxStake = (() => {
    if (selectedOption === '') return null;
    const i = parseInt(selectedOption);
    const O = pools[i] ?? 0;
    const L = pools.reduce((s, p, idx) => s + (idx === i ? 0 : (p || 0)), 0);
    if (L <= 0) return null; // first-mover state has its own warning
    const k = 0.9 * (1 - 0.015);   // payout-pool fraction of net stake
    const denom = 1 - k;            // ≈ 0.1135
    const s = (k * L - denom * O) / denom;
    if (!Number.isFinite(s) || s < 100) return null;
    return Math.floor(s);
  })();

  // Fetch user balance + bet distribution on mount
  useEffect(() => {
    if (session?.user?.id) {
      supabase
        .from('users')
        .select('tngn_balance, bonus_balance')
        .eq('id', session.user.id)
        .single()
        .then(({ data }) => {
          if (data) setBalance((data.tngn_balance || 0) + (data.bonus_balance || 0));
        });
    }

    // Fetch real bet distribution + locked-odds config (if any).
    fetch(`/api/markets/chart?marketId=${market.id}&mode=distribution`)
      .then(r => r.json())
      .then(data => {
        if (data.distribution) setDistribution(data.distribution);
        if (data.isLockedOdds && data.lockedOdds) {
          setLockedConfig(data.lockedOdds);
        } else {
          setLockedConfig(null);
        }
      })
      .catch(() => {});
  }, [market.id, session?.user?.id]);

  const handlePlaceBet = async () => {
    if (!session?.access_token) {
      toast({ title: 'Please sign in to make a prediction', variant: 'destructive' });
      return;
    }
    if (!selectedOption) {
      toast({ title: 'Pick an outcome first', variant: 'destructive' });
      return;
    }
    if (!amount || Number(amount) < 100) {
      toast({ title: 'Minimum prediction is ₦100', variant: 'destructive' });
      return;
    }
    if (balance !== null && Number(amount) > balance) {
      toast({ title: 'Insufficient balance', description: 'Top up your account to continue.', variant: 'destructive' });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          marketId: market.id,
          outcomeIndex: parseInt(selectedOption),
          stakeAmount: Number(amount),
          // Present only when this stake came from someone's shared pick,
          // so the server can notify the sharer. Server re-resolves the
          // true owner from this id — it's never trusted as an identity.
          fromShareId: prefillFromShareId,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Prediction failed');

      toast({
        title: '✅ Prediction locked!',
        description: `₦${Number(amount).toLocaleString()} committed to ${market.options[parseInt(selectedOption)]}`,
      });

      // Pass the created bet id back so the parent can auto-open the
      // OPx Picks share modal — the user just made a pick and the
      // share prompt rides the dopamine of placing it.
      onSuccess(data?.betId || data?.bet?.id || data?.id);
    } catch (err: any) {
      toast({ title: 'Prediction failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4 pt-2 relative">
      {/* First-bet walkthrough — sits absolute over the form so the data
          loaders (balance, distribution) behind it run in parallel; user
          sees a populated form the moment they dismiss. Three plain
          sentences, including the parimutuel "strength" hook in #3 — that's
          the selling point fixed-odds books can't replicate, so we lean
          into it instead of apologising for the mechanic. */}
      {showWalkthrough && (
        <div className="absolute inset-0 z-20 bg-background/97 backdrop-blur-md flex items-start justify-center overflow-y-auto rounded-md">
          <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.12] via-emerald-500/[0.05] to-transparent p-5 space-y-4 w-full">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-semibold text-emerald-300">Quick — how this works</span>
            </div>
            <ol className="space-y-3 text-sm text-foreground/90 leading-relaxed">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-300">1</span>
                <span>Forget bookie odds. Everyone&rsquo;s stake goes into one pool.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-300">2</span>
                <span>When the market closes, the winners split the pool.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-300">3</span>
                <span>The more confident the crowd is, the bigger your payout for being right against them.</span>
              </li>
            </ol>
            <Button
              onClick={dismissWalkthrough}
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-black font-semibold"
            >
              Got it &mdash; let me predict
            </Button>
          </div>
        </div>
      )}

      {/* Real bet distribution bars */}
      {distribution.length > 0 && (
        <div className="space-y-1.5">
          {distribution.map((d, i) => (
            <div key={d.option} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-20 truncate">{d.option}</span>
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${d.percentage}%`,
                    background: i === 0 ? '#3b82f6' : i === 1 ? '#f59e0b' : '#ef4444',
                  }}
                />
              </div>
              <span className="text-xs font-medium w-8 text-right">{d.percentage}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Option selector */}
      <div className="grid grid-cols-3 gap-2">
        {market.options.map((opt, idx) => {
          const isSelected = selectedOption === idx.toString();
          return (
            <div
              key={idx}
              onClick={() => setSelectedOption(idx.toString())}
              aria-selected={isSelected}
              className={cn(
                'flex items-center justify-center rounded-lg border border-muted bg-popover/50 p-3 cursor-pointer transition-all text-sm font-medium text-center',
                getOptionStyle(opt)
              )}
            >
              {opt}
            </div>
          );
        })}
      </div>

      {/* Amount input */}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
        <Input
          type="number"
          placeholder="Amount (min ₦100)"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="pl-8 bg-transparent"
          min={100}
        />
      </div>


      {balance !== null && (
        <p className="text-xs text-right text-muted-foreground">
          Balance: ₦{balance.toLocaleString()} tNGN
        </p>
      )}

      {/* Locked-odds preview. Frozen rate + an honest "₦X – ₦Y if
          correct" range whose floor is the server-guaranteed minimum.
          No first-mover warning — the house seed is always present, so
          there is never a void/first-mover state on a locked market. */}
      {lockedPreview && (
        <div className="rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-emerald-500/[0.04] to-transparent p-3.5 animate-in fade-in slide-in-from-bottom-1">
          <div className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-[0.12em] text-emerald-300/90 font-semibold">
            <Sparkles className="w-3 h-3" /> Your stake locks at
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-3xl md:text-4xl font-black text-emerald-400 tracking-tight tabular-nums leading-none">
              {lockedPreview.lockedOdds.toFixed(2)}×
            </span>
            <span className="text-sm text-emerald-300/80 font-semibold tabular-nums">
              ₦{lockedPreview.floorPayout.toLocaleString()}
              {lockedPreview.upperPayout > lockedPreview.floorPayout && (
                <> – ₦{lockedPreview.upperPayout.toLocaleString()}</>
              )} if correct
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300/80">
            <TrendingUp className="w-3 h-3 shrink-0" />
            <span>Your rate is locked. Winnings climb as others predict the other way.</span>
          </div>
        </div>
      )}

      {payoutPreview && (() => {
        // No "first-mover" concept on screen anymore. Every parimutuel
        // bet displays the SAME thing a locked-odds bet does: a clean
        // guaranteed rate. We show MAX(pro-rata projection, floor) so:
        //   - empty / thin opposing pool → the floor (1.03× / 1.02×)
        //     binds, exactly what settlement pays.
        //   - rich opposing pool → the higher pro-rata number shows.
        // The settlement path pays MAX(pro-rata, floor) too, so the
        // displayed "₦X if correct" is always a real promise — never
        // the old sub-1.00× "you'd pay yourself back" number, and never
        // a scary "needs an opposing prediction" warning.
        const floor = displayFloorPayout(stakeNum);
        const useFloor = floor.payout >= payoutPreview.payout;
        const shownMultiplier = useFloor ? floor.multiplier : payoutPreview.multiplier;
        const shownPayout = useFloor ? floor.payout : payoutPreview.payout;
        return (
          <div className="rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-emerald-500/[0.04] to-transparent p-3.5 animate-in fade-in slide-in-from-bottom-1">
            <div className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-[0.12em] text-emerald-300/90 font-semibold">
              <Sparkles className="w-3 h-3" /> Your stake locks at
            </div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-3xl md:text-4xl font-black text-emerald-400 tracking-tight tabular-nums leading-none">
                {shownMultiplier.toFixed(2)}×
              </span>
              <span className="text-sm text-emerald-300/80 font-semibold tabular-nums">
                ₦{Math.round(shownPayout).toLocaleString()} if correct
              </span>
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground leading-snug">
              Guaranteed minimum. Climbs as more people predict the other way.
            </div>
          </div>
        );
      })()}

      {/* Negative-EV warning. Triggers when the prospective stake is
          large enough relative to the opposing pool that the user would
          take a loss even on a winning prediction (parimutuel: you
          mostly just pay yourself back, minus the 10% house rake).
          Stays clear of the first-mover case (no opposing side yet) —
          that has its own amber notice inside the payout card.
          Locked-odds markets never hit this — the floor guarantees a
          minimum — so it's parimutuel-only via payoutPreview. */}
      {payoutPreview && payoutPreview.multiplier < 1 && !payoutPreview.isFirstMover && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-3.5 animate-in fade-in slide-in-from-bottom-1">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1.5">
              <p className="text-xs font-semibold text-red-300">
                You&rsquo;d lose ₦{Math.round(Math.abs(payoutPreview.profit)).toLocaleString()} even if you win
              </p>
              <p className="text-[11px] text-red-200/80 leading-relaxed">
                This stake is too big for the opposing pool. You&rsquo;d be most of the winning side, so the
                payout would mostly be your own money back.
              </p>
              {suggestedMaxStake !== null ? (
                <button
                  type="button"
                  onClick={() => setAmount(String(suggestedMaxStake))}
                  className="text-[11px] font-semibold text-red-300 underline underline-offset-2 hover:text-red-200"
                >
                  Use ₦{suggestedMaxStake.toLocaleString()} (break-even max) →
                </button>
              ) : (
                <p className="text-[11px] text-red-200/60">
                  Wait for the opposing side to grow, then try again.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {(!selectedOption || !amount || Number(amount) < 100) && (
        <p className="text-[11px] text-center text-muted-foreground/70 -mb-1">
          {!selectedOption ? 'Pick an outcome' : !amount ? 'Enter an amount' : 'Minimum ₦100'}
          <span className="mx-1">→</span>
          <span className="text-foreground/80">Lock Prediction</span>
        </p>
      )}

      {/* Preview your share card — pre-bet OPx Picks preview. Tappable
          as soon as the user has picked an outcome AND typed a stake;
          the preview modal uses the same OG renderer the real share
          card uses, parameterised by the in-flight bet inputs. After
          the bet locks, the real share modal auto-opens with the real
          bet id (handled at MarketList level). */}
      {selectedOption !== '' && stakeNum >= 100 && (
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
        >
          <Sparkles className="w-3 h-3 text-emerald-400" />
          Preview your OPx Pick before locking
        </button>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <Button variant="outline" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
        )}
        <Button
          onClick={handlePlaceBet}
          disabled={isLoading}
          className="flex-1 bg-foreground text-background hover:bg-foreground/90 font-semibold"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Locking...
            </span>
          ) : 'Lock Prediction'}
        </Button>
      </div>

      {previewOpen && (() => {
        // Resolve the odds we should show in the preview: locked-odds
        // floor if this is a locked market, parimutuel floor / projection
        // otherwise, falling back to 1.0× so the card still renders.
        const odds = lockedPreview?.lockedOdds
          ?? (payoutPreview ? Math.max(payoutPreview.multiplier, displayFloorPayout(stakeNum).multiplier) : 1.0);
        return (
          <PickPreviewModal
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            marketId={market.id}
            outcomeIndex={selectedOption === '' ? null : parseInt(selectedOption)}
            stakeTngn={stakeNum}
            odds={odds}
            handle={userHandle}
          />
        );
      })()}

      {/* Add to Multiplier — only on locked-odds markets (the engine
          rejects parimutuel legs). Soft violet so it reads as a distinct
          path from the single-bet "Lock Prediction" above. Adds the
          currently-selected outcome as a leg; one leg per market, so
          re-adding swaps the pick. */}
      {isLockedMarket && (
        <button
          type="button"
          disabled={!selectedOption}
          onClick={() => {
            const idx = parseInt(selectedOption);
            const cleanQ = market.question.replace(/\[.*?\]\s*/g, '').trim();
            addLeg({
              marketId: market.id,
              outcomeIndex: idx,
              marketQuestion: cleanQ || `Market ${market.id}`,
              optionLabel: market.options[idx],
            });
            setSlipOpen(true);
          }}
          className={cn(
            'w-full flex items-center justify-center gap-2 h-10 rounded-lg text-sm font-semibold transition-colors',
            'border border-violet-500/30 text-violet-300 bg-violet-500/[0.06] hover:bg-violet-500/15',
            !selectedOption && 'opacity-50 cursor-not-allowed',
            slipHasMarket(market.id) && 'bg-violet-500/15 border-violet-500/50',
          )}
        >
          <Layers className="w-4 h-4" />
          {slipHasMarket(market.id) ? 'Update in Multiplier' : 'Add to Multiplier'}
        </button>
      )}
    </div>
  );
}

// Always-visible Multiplier picker on locked-odds market cards. Shows
// each outcome as a small chip — tap to add as a leg, tap again to
// remove. One leg per market: adding a different outcome swaps the
// existing pick. Stays unobtrusive so it doesn't compete with the main
// "tap to predict" affordance for singles.
function MultiplierQuickPick({ market }: { market: Market }) {
  const { addLeg, removeLeg, hasLeg, setOpen } = useSlip();
  const cleanQ = market.question.replace(/\[.*?\]\s*/g, '').trim();

  return (
    <div className="mb-3 rounded-md border border-violet-500/15 bg-violet-500/[0.04] px-2.5 py-2 flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-violet-300/90 font-semibold">
        <Layers className="w-3 h-3" /> Multiplier
      </div>
      <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
        {market.options.map((opt, i) => {
          const picked = hasLeg(market.id, i);
          return (
            <button
              key={i}
              type="button"
              onClick={(e) => {
                // Don't trigger any parent-card expand handlers.
                e.stopPropagation();
                if (picked) {
                  removeLeg(market.id);
                } else {
                  addLeg({
                    marketId: market.id,
                    outcomeIndex: i,
                    marketQuestion: cleanQ || `Market ${market.id}`,
                    optionLabel: opt,
                  });
                  setOpen(true);
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
                picked
                  ? 'bg-violet-500 text-white border border-violet-500'
                  : 'bg-background/40 border border-violet-500/25 text-violet-200 hover:bg-violet-500/15',
              )}
            >
              {picked ? <CheckCircle2 className="w-3 h-3" /> : <span className="text-violet-300/80">+</span>}
              <span className="truncate max-w-[120px]">{opt}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MarketCard({
  market,
  session,
  onBetPlaced,
  hideViewMore = false,
  isStaked = false,
  prefillOutcomeIndex,
  prefillStakeTngn,
  prefillEditStake = false,
  prefillFromShareId,
  autoOpen = false,
}: MarketCardProps) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(!!autoOpen);

  // Sync with autoOpen prop changes — important when the invitee
  // arrives after the card has already mounted (e.g. a re-render
  // triggered by the stash being read post-auth).
  useEffect(() => {
    if (autoOpen) setIsExpanded(true);
  }, [autoOpen]);
  const [showDescription, setShowDescription] = useState(false);

  const closesAt = new Date(market.closes_at);
  const isOpen = market.status === 'open' && closesAt > new Date();
  const isLocked = market.status === 'locked';
  const isResolved = market.status === 'resolved';
  const isVoided = market.status === 'voided';

  // Strip bracket tags from question (e.g. "[PL] Arsenal vs Chelsea" → "Arsenal vs Chelsea")
  const cleanQuestion = market.question.replace(/\[.*?\]\s*/g, '').trim();
  // For child markets in the event view, strip the parent prefix
  const displayQuestion = market.parent_market_id
    ? (cleanQuestion.match(/\(([^)]+)\)$/) || [])[1] || cleanQuestion
    : cleanQuestion;

  const statusBadge = () => {
    if (isResolved) return <Badge variant="secondary" className="text-[10px]">RESOLVED</Badge>;
    if (isVoided) return <Badge variant="destructive" className="text-[10px]">VOIDED</Badge>;
    if (isLocked) return (
      <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[10px] flex items-center gap-1">
        <Lock className="w-2.5 h-2.5" /> LOCKED
      </Badge>
    );
    if (isOpen) return (
      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] flex items-center gap-1">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
        </span>
        OPEN
      </Badge>
    );
    return <Badge variant="outline" className="text-[10px]">CLOSED</Badge>;
  };

  const resolvedOption = isResolved && market.resolved_outcome !== null
    ? market.options[market.resolved_outcome]
    : null;

  return (
    <Card
      data-market-id={market.id}
      className="hover:shadow-lg transition-all bg-card relative overflow-hidden group border-muted"
    >
      <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/5 via-transparent to-red-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

      <CardHeader className="p-4 md:p-6 pb-2 md:pb-2 relative z-10">
        <div className="flex justify-between items-start gap-3">
          <CardTitle className="text-base font-medium tracking-tight text-foreground leading-snug min-w-0">
            <span className="min-w-0 whitespace-pre-wrap break-words">{displayQuestion}</span>
          </CardTitle>
          <div className="shrink-0 flex items-center gap-1.5">
            {isStaked && (
              <Badge
                className="text-[10px] gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-semibold"
                variant="outline"
              >
                <CheckCircle2 className="w-2.5 h-2.5" /> PREDICTED
              </Badge>
            )}
            {statusBadge()}
          </div>
        </div>
        {market.description && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowDescription(s => !s)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-foreground transition-colors"
            >
              <Info className="w-3 h-3" />
              <span className="underline-offset-2 hover:underline">About this market</span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', showDescription && 'rotate-180')} />
            </button>
            {showDescription && (
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed bg-muted/30 border border-border/40 rounded-md px-2.5 py-2 animate-in fade-in slide-in-from-top-1 whitespace-pre-wrap break-words">
                {market.description}
              </p>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="px-4 md:px-6 pb-4 md:pb-6 relative z-10">
        {/* Resolved outcome */}
        {isResolved && resolvedOption && (
          <div className="flex items-center gap-2 mb-3 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-emerald-400 font-medium">Result: {resolvedOption}</span>
          </div>
        )}

        {/* Pool + deadline — wraps on narrow phones so neither label gets cut off.
            Pool tNGN is hidden until the market locks/resolves: showing a small
            pool pre-lock looks weak and tips traders off. Once locked the
            number is no longer actionable, so it's safe to reveal. */}
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1 mb-3">
          {(isLocked || isResolved) && (
            <span className="flex items-center gap-1 min-w-0">
              <TrendingUp className="w-3 h-3 shrink-0" />
              <span className="truncate">Pool: ₦{getDisplayPool(market.total_pool).toLocaleString()} tNGN</span>
            </span>
          )}
          <span className="flex items-center gap-1 shrink-0">
            <Clock className="w-3 h-3" />
            {isResolved || isLocked
              ? `Closed ${closesAt.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}`
              : `Closes ${closesAt.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
            }
          </span>
        </div>

        {/* On-chain verification badge */}
        {market.merkle_root && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-400/70 mb-3">
            <Lock className="w-3 h-3" />
            <span>Prediction ledger sealed on Polygon</span>
          </div>
        )}

        {/* Always-visible Multiplier quick-pick on open locked-odds
            markets. Lets the user add legs to their slip while browsing
            the market list — no need to expand the full bet form for
            each one. The full bet form (below) is still the path for
            single-bet placement. Soft violet so it visually belongs to
            the Multiplier surface, not the singles flow. */}
        {isOpen && market.is_locked_odds && (
          <MultiplierQuickPick market={market} />
        )}

        {/* Desktop inline betting */}
        {isOpen && isExpanded && (
          <div className="hidden md:block border-t border-muted/50 mt-3 pt-3 animate-in fade-in slide-in-from-top-2">
            <BettingInterface
              market={market}
              session={session}
              onSuccess={(betId) => {
                setIsExpanded(false);
                onBetPlaced(market.id, betId);
              }}
              onCancel={() => setIsExpanded(false)}
              prefillOutcomeIndex={prefillOutcomeIndex}
              prefillStakeTngn={prefillEditStake ? undefined : prefillStakeTngn}
              prefillFromShareId={prefillFromShareId}
            />
          </div>
        )}
      </CardContent>

      <CardFooter className="px-4 md:px-6 pb-4 md:pb-6 pt-0 flex gap-2 relative z-10">
        {/* Desktop place bet */}
        <div className="hidden md:flex gap-2 w-full">
          {isOpen && !isExpanded && (
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs bg-muted/20 hover:bg-muted/50"
              onClick={() => setIsExpanded(true)}
            >
              Predict
            </Button>
          )}
        </div>

        {/* Mobile drawer */}
        <div className="md:hidden w-full">
          {isOpen ? (
            <Drawer open={isExpanded} onOpenChange={setIsExpanded}>
              <DrawerTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full text-xs bg-muted/20 hover:bg-muted/50">
                  Tap to Predict
                </Button>
              </DrawerTrigger>
              {/* Vaul drawer scroll mechanics:
                  - DrawerContent gets the height cap (90vh).
                  - Inner column uses flex-1 + min-h-0 so it fills the
                    drawer below Vaul's injected handle bar, and the
                    middle child can actually grow/shrink instead of
                    stacking past the bottom edge.
                  - data-vaul-no-drag on the scrollable middle is the
                    critical bit: without it, Vaul's swipe-down-to-
                    dismiss gesture eats every vertical touch event,
                    so overflow-y-auto is dead on mobile. The flag
                    tells Vaul "leave touches in this region alone"
                    so they reach the scroll container instead.
                  pb-[max(safe-area,1.5rem)] clears the iOS home bar. */}
              <DrawerContent className="max-h-[90vh] pb-[max(env(safe-area-inset-bottom),1.5rem)]">
                <div className="mx-auto w-full max-w-sm flex flex-col flex-1 min-h-0">
                  <DrawerHeader className="shrink-0">
                    <DrawerTitle className="text-base">{displayQuestion}</DrawerTitle>
                    <DrawerDescription>Make your prediction</DrawerDescription>
                  </DrawerHeader>
                  <div
                    data-vaul-no-drag
                    className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 pb-0"
                  >
                    <BettingInterface
                      market={market}
                      session={session}
                      onSuccess={(betId) => {
                        setIsExpanded(false);
                        onBetPlaced(market.id, betId);
                      }}
                      prefillOutcomeIndex={prefillOutcomeIndex}
                      prefillStakeTngn={prefillEditStake ? undefined : prefillStakeTngn}
                      prefillFromShareId={prefillFromShareId}
                    />
                  </div>
                  <DrawerFooter className="shrink-0 pb-6">
                    <DrawerClose asChild>
                      <Button variant="outline">Close</Button>
                    </DrawerClose>
                  </DrawerFooter>
                </div>
              </DrawerContent>
            </Drawer>
          ) : (
            !isResolved && !isVoided && (
              <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground py-1">
                <Lock className="w-3 h-3" />
                {isLocked ? 'Predictions closed' : 'Market closed'}
              </div>
            )
          )}
        </div>

        {/* View more markets (parent markets only) */}
        {!hideViewMore && !market.parent_market_id && (
          <Button
            variant="outline"
            size="sm"
            className="text-xs shrink-0 gap-1"
            onClick={() => router.push(`/event/${market.id}`)}
          >
            <ExternalLink className="w-3 h-3" />
            Sub-Markets
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

type CategoryFilter = {
  category: string | null;
  sport: string | null;
  excludeSport: string | null;
  leagueCode: string | null;
  questionFilter: string | null;
  trendingOnly: boolean;
  excludeTrending: boolean;
};

function buildCategoryFilter(category: string, subcategory: string | null): CategoryFilter {
  const base: CategoryFilter = {
    category: null,
    sport: null,
    excludeSport: null,
    leagueCode: null,
    questionFilter: null,
    trendingOnly: false,
    excludeTrending: false,
  };

  // Top-tab model:
  //   trending -> only is_trending=true markets (admin-curated, ~5 hot ones)
  //   new      -> everything EXCEPT trending, newest first
  //   ball     -> sports excluding fight (UFC/boxing has its own tab)
  //   fight    -> sports.sport='fight' (boxing, MMA, UFC)
  //   politics -> politics + geo (world events)
  //   economy  -> economics + finance + crypto + tech (everything money-adjacent)
  const LEAGUE_CODE_MAP: Record<string, string> = {
    pl: 'PL', pd: 'PD', sa: 'SA', bl1: 'BL1', fl1: 'FL1',
    cl: 'CL', wc: 'WC', ec: 'EC', ded: 'DED', bsa: 'BSA',
    ppl: 'PPL', elc: 'ELC',
    nba: 'NBA', euroleague: 'EUROLEAGUE',
    lol: 'LOL', csgo: 'CSGO', dota2: 'DOTA2', valorant: 'VAL', r6s: 'R6S',
  };
  const SUBCATEGORY_TO_SPORT: Record<string, string> = {
    football: 'football',
    basketball: 'basketball',
    esports: 'esports',
    motorsport: 'motorsport',
  };

  if (category === 'trending') {
    // Admin-curated featured set only — kept small (~3-5 markets) so
    // it actually means something. Default tab on the markets list.
    base.trendingOnly = true;
    return base;
  }

  if (category === 'new') {
    // Everything that isn't currently featured — newest first via the
    // sort fall-through. Lives next to Trending so users have a clear
    // "ok where's everything else" tab.
    base.excludeTrending = true;
    return base;
  }

  if (category === 'ball') {
    base.category = 'sports';
    // Combat sports get their own tab — exclude here so UFC/boxing
    // markets don't bleed into football / basketball / esports views.
    base.excludeSport = 'fight';
    base.sport = subcategory && SUBCATEGORY_TO_SPORT[subcategory] ? SUBCATEGORY_TO_SPORT[subcategory] : null;
    if (subcategory && LEAGUE_CODE_MAP[subcategory]) {
      base.leagueCode = LEAGUE_CODE_MAP[subcategory];
    }
    return base;
  }

  if (category === 'fight') {
    base.category = 'sports';
    base.sport = 'fight';
    return base;
  }

  if (category === 'politics') {
    base.category = 'politics';
    return base;
  }

  if (category === 'crypto') {
    // Crypto is back as a top-level category. Stored markets may use either
    // "crypto" or "tech" (legacy mix), so we look at both via .in().
    base.category = 'crypto_or_tech'; // sentinel handled in the query
    return base;
  }

  if (category === 'economy') {
    // "Everything Economy" — economics + finance + entertainment + geo.
    // Crypto split back out into its own top-level entry, so it's no longer
    // folded in here. The list-fetch logic handles this via .in() filter.
    base.category = 'economy_or_finance'; // sentinel handled in the query
    return base;
  }

  // Legacy params (tech, entertainment, geo) — redirect into economy bucket
  if (['tech', 'entertainment', 'geo'].includes(category)) {
    base.category = 'economy_or_finance';
    return base;
  }

  base.category = category;
  return base;
}

interface MarketListProps {
  filterExactMarketId?: number;
  filterChildrenOfParentId?: number;
  leagueCode?: string;
  /** Scope the whole list to one sport (e.g. "football"). Used by the
      /football hub when no specific league is selected. */
  sport?: string;
}

export function MarketList({ filterExactMarketId, filterChildrenOfParentId, leagueCode, sport }: MarketListProps) {
  const searchParams = useSearchParams();
  const category = searchParams.get('category') || 'trending';
  const subcategory = searchParams.get('subcategory') || null;

  const [markets, setMarkets] = useState<Market[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [stakedMarketIds, setStakedMarketIds] = useState<Set<number>>(new Set());
  const sortParam = searchParams.get('sort') || 'new';
  const statusParam = searchParams.get('status') || 'open';
  const searchQuery = (searchParams.get('q') || '').trim();

  // OPx Picks — invitee landed here after tapping "Stake as is" /
  // "Make It Yours" on a /p/bet/[id] page. The intent was stashed in
  // localStorage; we read it once on mount, pre-open the matching
  // market card with the inviter's outcome and stake pre-filled, and
  // then clear the stash so a refresh doesn't replay it.
  const [stakeIntent, setStakeIntent] = useState<{
    type: 'bet';
    marketId: number;
    outcomeIndex: number;
    stakeTngn: number;
    editStake: boolean;
    fromShareId: string;
  } | null>(null);

  const slip = useSlip();

  useEffect(() => {
    try {
      const raw = localStorage.getItem('opx_stake_intent');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      localStorage.removeItem('opx_stake_intent');

      if (parsed?.type === 'bet' && parsed.marketId !== undefined) {
        setStakeIntent({
          type: 'bet',
          marketId: Number(parsed.marketId),
          outcomeIndex: Number(parsed.outcomeIndex),
          stakeTngn: Number(parsed.stakeTngn || 0),
          editStake: !!parsed.editStake,
          fromShareId: String(parsed.fromShareId || ''),
        });
        return;
      }

      if (parsed?.type === 'slip' && Array.isArray(parsed.legs)) {
        // Fetch the inviter's slip so we have market questions + option
        // labels (the SlipLeg shape needs them so the drawer can render
        // without a follow-up fetch per leg). The /api/picks/slip
        // endpoint already returns this in the right shape.
        (async () => {
          try {
            const res = await fetch(`/api/picks/slip/${encodeURIComponent(String(parsed.fromShareId || ''))}`);
            if (!res.ok) return;
            const body = await res.json();
            const fetchedLegs = Array.isArray(body?.legs) ? body.legs : [];
            const slipLegs = fetchedLegs.map((l: any) => ({
              marketId: Number(l.marketId),
              outcomeIndex: Number(l.outcomeIndex),
              marketQuestion: String(l?.market?.question || ''),
              optionLabel: String(l.pickLabel || ''),
            })).filter((l: any) => Number.isFinite(l.marketId) && Number.isFinite(l.outcomeIndex));
            if (slipLegs.length === 0) return;
            slip.replaceLegs(slipLegs);
            // Remember which shared slip this came from so the server can
            // notify the sharer when this slip is placed (whether staked
            // as-is or after edits).
            slip.setFromShareId(String(parsed.fromShareId || '') || null);
            if (!parsed.editStake && Number(parsed.stakeTngn) > 0) {
              slip.setPrefillStakeNgn(Number(parsed.stakeTngn));
            }
            slip.setOpen(true);
          } catch { /* swallow — user can still build manually */ }
        })();
      }
    } catch { /* no-op */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OPx Picks — auto-share modal after a fresh bet placement. When
  // onBetPlaced fires with a bet id, we capture it and pop the share
  // modal so the user can post their pick at the dopamine peak. Null
  // resets after the modal closes.
  const [autoSharePick, setAutoSharePick] = useState<{ type: 'bet' | 'slip'; id: string } | null>(null);
  const [shareUsername, setShareUsername] = useState<string | null>(null);
  useEffect(() => {
    if (!session?.user?.id) { setShareUsername(null); return; }
    let alive = true;
    supabase.from('users').select('username, first_name').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (alive) setShareUsername((data?.username || data?.first_name || null) as string | null);
      });
    return () => { alive = false; };
  }, [session?.user?.id]);

  // Per-view scroll key. /markets uses category+subcategory+filters so each
  // tab remembers its own position; the sub-market and league hubs get
  // their own keys so back-navigating into them lands you where you were.
  const scrollKey = `mlist_${filterExactMarketId ?? ''}_${filterChildrenOfParentId ?? ''}_${leagueCode ?? ''}_${sport ?? ''}_${category}_${subcategory ?? ''}_${sortParam}_${statusParam}_${searchQuery}`;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Pull the set of market IDs the current user has any active stake on,
  // so we can flag those cards with a "STAKED" badge.
  const fetchStakedMarkets = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('user_bets')
      .select('market_id')
      .eq('user_id', userId)
      .in('status', ['active', 'won', 'lost']);
    setStakedMarketIds(new Set((data || []).map((b: any) => b.market_id)));
  }, []);

  useEffect(() => {
    if (session?.user?.id) fetchStakedMarkets(session.user.id);
    else setStakedMarketIds(new Set());
  }, [session, fetchStakedMarkets]);

  const fetchMarkets = useCallback(async (opts?: { silent?: boolean }) => {
    // `silent` background refreshes don't toggle the loading skeleton.
    // We use it after a bet lands so the list updates the pool numbers
    // in place without collapsing the rows and resetting scroll —
    // users were getting punted back to the top after every stake.
    if (!opts?.silent) setIsLoading(true);
    try {
      // Hide voided markets, and resolved markets older than 26 hours.
      // Data stays in DB (audit trail intact) — this is purely a display filter.
      const cutoff = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
      let query = supabase
        .from('markets')
        .select('id, title, question, category, options, status, closes_at, total_pool, resolved_outcome, parent_market_id, on_chain_market_id, merkle_root, description, resolved_at, is_trending, trending_rank, is_locked_odds, published_at')
        .not('status', 'eq', 'voided')
        // Scheduled markets haven't opened yet, and pending_void markets
        // are mid-investigation — neither is meant to be public, in any
        // status view including "All".
        .not('status', 'eq', 'scheduled')
        .not('status', 'eq', 'pending_void')
        .or(`status.neq.resolved,resolved_at.gte.${cutoff}`);

      // Sort. Explicit picks ('closing' / 'pool' from the toolbar) win on
      // every tab, Trending included — sorting the curated set by closing
      // time or pool size is still a useful override. Absent an explicit
      // pick, sortParam defaults to 'new' — but on the Trending tab "new"
      // doesn't mean recency, it means the admin-curated manual order, so
      // that default is special-cased to trending_rank instead of id.
      // Everywhere else, "new" sorts by published_at — when a market
      // actually went live — rather than id/created_at, so a market
      // authored ahead of time via a schedule still lands at the top of
      // New the moment it opens instead of being buried under whatever
      // was created (not necessarily opened) in the meantime. Secondary
      // ordering by id keeps ties (equal published_at, or legacy nulls)
      // stable rather than reshuffling on every refetch.
      if (sortParam === 'closing') query = query.order('closes_at', { ascending: true });
      else if (sortParam === 'pool') query = query
        .order('total_pool', { ascending: false })
        .order('id', { ascending: false });
      else if (category === 'trending') query = query
        .order('trending_rank', { ascending: true, nullsFirst: false })
        .order('id', { ascending: false });
      else query = query
        .order('published_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false });

      if (filterExactMarketId !== undefined) {
        query = query.eq('id', filterExactMarketId);
      } else if (filterChildrenOfParentId !== undefined) {
        query = query.eq('parent_market_id', filterChildrenOfParentId);
      } else if (leagueCode) {
        // leagueCode prop passes League.code (e.g. "[PL]"). Strip brackets to match league_code column.
        const stripped = leagueCode.replace(/[\[\]]/g, '');
        query = query
          .is('parent_market_id', null)
          .eq('category', 'sports')
          .eq('league_code', stripped);
      } else if (sport) {
        // Sport-scoped list (e.g. /football "All" tab) — pull every market
        // for the sport regardless of league.
        query = query
          .is('parent_market_id', null)
          .eq('category', 'sports')
          .eq('sport', sport);
      } else {
        // General market list — top-level only
        query = query.is('parent_market_id', null);

        const filter = buildCategoryFilter(category, subcategory);
        // Sentinels span multiple legacy category strings — crypto pulls
        // both 'crypto' and 'tech', Everything Economy gets the rest.
        if (filter.category === 'economy_or_finance') {
          query = query.in('category', ['economy', 'economics', 'finance', 'entertainment', 'geo', 'geopolitics']);
        } else if (filter.category === 'crypto_or_tech') {
          query = query.in('category', ['crypto', 'tech']);
        } else if (filter.category) {
          query = query.eq('category', filter.category);
        }
        if (filter.sport) query = query.eq('sport', filter.sport);
        if (filter.excludeSport) query = query.not('sport', 'eq', filter.excludeSport);
        if (filter.leagueCode) query = query.eq('league_code', filter.leagueCode);
        if (filter.questionFilter) query = query.ilike('question', `%${filter.questionFilter}%`);
        if (filter.trendingOnly) query = query.eq('is_trending', true);
        if (filter.excludeTrending) query = query.eq('is_trending', false);

        // Status filter (Open / Locked / Resolved / All)
        if (statusParam === 'open') query = query.eq('status', 'open');
        else if (statusParam === 'locked') query = query.eq('status', 'locked');
        else if (statusParam === 'resolved') query = query.eq('status', 'resolved');
        // 'all' = no further status filter

        // Fuzzy-ish search: split into tokens, require each to appear in question OR title.
        // Postgres ilike with % wildcards gives us substring matching that tolerates
        // word-order shuffling. Good enough for typo-light, partial-word queries.
        if (searchQuery) {
          const tokens = searchQuery.split(/\s+/).filter(Boolean).slice(0, 4);
          for (const tok of tokens) {
            const safe = tok.replace(/[%_]/g, '');
            query = query.or(`question.ilike.%${safe}%,title.ilike.%${safe}%`);
          }
        }
      }

      const { data, error } = await query.limit(50);
      if (error) throw error;
      setMarkets((data || []) as Market[]);
    } catch (err) {
      console.error('Failed to fetch markets:', err);
    } finally {
      setIsLoading(false);
    }
  }, [filterExactMarketId, filterChildrenOfParentId, category, subcategory, leagueCode, sortParam, statusParam, searchQuery]);

  useEffect(() => { fetchMarkets(); }, [fetchMarkets]);

  // Restore scroll position when the same view re-mounts (e.g. user navigates
  // into /event/X and uses back, or hops between tabs and returns). Without
  // this Next.js dumps users at scrollY=0 every time, which is exhausting on
  // mobile where they may have scrolled past 30+ cards. Falls through to
  // scrollY=0 when switching to a tab with no saved position, so a fresh
  // tab opens at the top regardless of where they were scrolled before.
  useEffect(() => {
    if (isLoading || markets.length === 0) return;
    try {
      const saved = sessionStorage.getItem(scrollKey);
      const y = saved !== null ? parseInt(saved, 10) : 0;
      if (Number.isFinite(y)) {
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, isLoading]);

  // Persist scroll position as the user scrolls, debounced so we're not
  // hammering sessionStorage on every wheel tick. Re-registered when the
  // view changes so each tab's position is keyed independently.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { sessionStorage.setItem(scrollKey, String(window.scrollY)); } catch {}
      }, 150);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [scrollKey]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-36 rounded-xl shimmer" />
        ))}
      </div>
    );
  }

  if (markets.length === 0) {
    // Trending starts empty until admin flags a few featured markets;
    // nudge users to the New tab so the empty Trending isn't a dead end.
    const trendingEmpty = category === 'trending' && !filterChildrenOfParentId && !filterExactMarketId;
    return (
      <div className="text-center p-12 border border-muted rounded-xl bg-card/50">
        <p className="text-muted-foreground">
          {filterChildrenOfParentId
            ? 'No sub-markets for this event.'
            : trendingEmpty
              ? "No featured markets right now. Tap 'New' for everything else."
              : 'No markets in this category yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {markets.map((market) => {
        const isPickTarget = stakeIntent?.type === 'bet' && Number(stakeIntent.marketId) === Number(market.id);
        return (
          <MarketCard
            key={market.id}
            market={market}
            session={session}
            onBetPlaced={async (id, betId) => {
              // Silent refetch (no skeleton) + re-anchor to the card the user
              // just bet on so they stay in context. Without the scrollIntoView
              // the silent refetch reorders cards (pool changed) and users
              // would be looking at a different market at the same scrollY.
              await fetchMarkets({ silent: true });
              if (session?.user?.id) fetchStakedMarkets(session.user.id);
              requestAnimationFrame(() => {
                const card = document.querySelector<HTMLElement>(`[data-market-id="${id}"]`);
                card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              });
              if (betId) {
                setAutoSharePick({ type: 'bet', id: betId });
              }
            }}
            hideViewMore={filterExactMarketId !== undefined || filterChildrenOfParentId !== undefined}
            isStaked={stakedMarketIds.has(market.id)}
            prefillOutcomeIndex={isPickTarget ? stakeIntent!.outcomeIndex : undefined}
            prefillStakeTngn={isPickTarget ? stakeIntent!.stakeTngn : undefined}
            prefillEditStake={isPickTarget ? stakeIntent!.editStake : undefined}
            prefillFromShareId={isPickTarget ? stakeIntent!.fromShareId : undefined}
            autoOpen={isPickTarget}
          />
        );
      })}

      {/* Auto-share prompt after a bet places successfully. The user
          just made a pick — surface the OPx Picks share modal so they
          can post it while the dopamine is fresh. */}
      {autoSharePick && (
        <SharePickModal
          open={autoSharePick !== null}
          onClose={() => setAutoSharePick(null)}
          type={autoSharePick.type}
          id={autoSharePick.id}
          defaultUsername={shareUsername}
        />
      )}
    </div>
  );
}
