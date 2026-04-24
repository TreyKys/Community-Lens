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
import { Loader2, Lock, TrendingUp, Clock, CheckCircle2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

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
}

interface MarketCardProps {
  market: Market;
  session: any;
  onBetPlaced: (marketId: number) => void;
  hideViewMore?: boolean;
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
}: {
  market: Market;
  session: any;
  onSuccess: () => void;
  onCancel?: () => void;
}) {
  const [selectedOption, setSelectedOption] = useState('');
  const [amount, setAmount] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [distribution, setDistribution] = useState<{ option: string; percentage: number }[]>([]);
  const { toast } = useToast();

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

    // Fetch real bet distribution
    fetch(`/api/markets/chart?marketId=${market.id}&mode=distribution`)
      .then(r => r.json())
      .then(data => {
        if (data.distribution) setDistribution(data.distribution);
      })
      .catch(() => {});
  }, [market.id, session?.user?.id]);

  const handlePlaceBet = async () => {
    if (!session?.access_token) {
      toast({ title: 'Please sign in to place a bet', variant: 'destructive' });
      return;
    }
    if (!selectedOption) {
      toast({ title: 'Pick an outcome first', variant: 'destructive' });
      return;
    }
    if (!amount || Number(amount) < 100) {
      toast({ title: 'Minimum bet is ₦100', variant: 'destructive' });
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
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bet failed');

      const isJackpot = data.isJackpotEligible;
      toast({
        title: isJackpot ? '🏆 Bet locked — Jackpot eligible!' : '✅ Prediction locked!',
        description: `₦${Number(amount).toLocaleString()} staked on ${market.options[parseInt(selectedOption)]}${isJackpot ? ' — this slip enters the weekly jackpot.' : ''}`,
      });

      onSuccess();
    } catch (err: any) {
      toast({ title: 'Bet failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4 pt-2">
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

      {(!selectedOption || !amount || Number(amount) < 100) && (
        <p className="text-[11px] text-center text-muted-foreground/70 -mb-1">
          {!selectedOption ? 'Pick an outcome' : !amount ? 'Enter an amount' : 'Minimum ₦100'}
          <span className="mx-1">→</span>
          <span className="text-foreground/80">Lock Prediction</span>
        </p>
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
    </div>
  );
}

function MarketCard({ market, session, onBetPlaced, hideViewMore = false }: MarketCardProps) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(false);

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
    <Card className="hover:shadow-lg transition-all bg-card relative overflow-hidden group border-muted">
      <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/5 via-transparent to-red-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

      <CardHeader className="pb-2 relative z-10">
        <div className="flex justify-between items-start gap-3">
          <CardTitle className="text-base font-medium tracking-tight text-foreground leading-snug">
            {displayQuestion}
          </CardTitle>
          <div className="shrink-0">{statusBadge()}</div>
        </div>
      </CardHeader>

      <CardContent className="relative z-10">
        {/* Resolved outcome */}
        {isResolved && resolvedOption && (
          <div className="flex items-center gap-2 mb-3 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-emerald-400 font-medium">Result: {resolvedOption}</span>
          </div>
        )}

        {/* Pool + deadline */}
        <div className="flex justify-between text-xs text-muted-foreground mt-1 mb-3">
          <span className="flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            Pool: ₦{(market.total_pool || 0).toLocaleString()} tNGN
          </span>
          <span className="flex items-center gap-1">
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
            <span>Bet book sealed on Polygon</span>
          </div>
        )}

        {/* Desktop inline betting */}
        {isOpen && isExpanded && (
          <div className="hidden md:block border-t border-muted/50 mt-3 pt-3 animate-in fade-in slide-in-from-top-2">
            <BettingInterface
              market={market}
              session={session}
              onSuccess={() => {
                setIsExpanded(false);
                onBetPlaced(market.id);
              }}
              onCancel={() => setIsExpanded(false)}
            />
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-0 flex gap-2 relative z-10">
        {/* Desktop place bet */}
        <div className="hidden md:flex gap-2 w-full">
          {isOpen && !isExpanded && (
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs bg-muted/20 hover:bg-muted/50"
              onClick={() => setIsExpanded(true)}
            >
              Place Bet
            </Button>
          )}
        </div>

        {/* Mobile drawer */}
        <div className="md:hidden w-full">
          {isOpen ? (
            <Drawer open={isExpanded} onOpenChange={setIsExpanded}>
              <DrawerTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full text-xs bg-muted/20 hover:bg-muted/50">
                  Tap to Place Bet
                </Button>
              </DrawerTrigger>
              <DrawerContent>
                <div className="mx-auto w-full max-w-sm">
                  <DrawerHeader>
                    <DrawerTitle className="text-base">{displayQuestion}</DrawerTitle>
                    <DrawerDescription>Make your prediction</DrawerDescription>
                  </DrawerHeader>
                  <div className="p-4 pb-0">
                    <BettingInterface
                      market={market}
                      session={session}
                      onSuccess={() => {
                        setIsExpanded(false);
                        onBetPlaced(market.id);
                      }}
                    />
                  </div>
                  <DrawerFooter>
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
                {isLocked ? 'Betting closed' : 'Market closed'}
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

// Category → Supabase query mapping
function buildCategoryFilter(category: string, subcategory: string | null) {
  const base = {
    column: 'category',
    value: '',
    questionFilter: null as string | null,
  };

  const SPORTS_LEAGUE_MAP: Record<string, string> = {
    pl: '[PL]', pd: '[PD]', sa: '[SA]', bl1: '[BL1]', fl1: '[FL1]',
    cl: '[CL]', wc: '[WC]', ec: '[EC]', ded: '[DED]', bsa: '[BSA]',
    ppl: '[PPL]', elc: '[ELC]', nba: '[NBA]',
  };

  if (category === 'sports' || category === 'trending') {
    base.column = 'category';
    base.value = 'sports';
    if (subcategory && SPORTS_LEAGUE_MAP[subcategory]) {
      base.questionFilter = SPORTS_LEAGUE_MAP[subcategory];
    }
  } else if (category === 'politics') {
    base.value = 'politics';
  } else if (category === 'crypto') {
    base.value = 'finance';
  } else if (category === 'entertainment') {
    base.value = 'entertainment';
    const ENTERTAINMENT_TAG_MAP: Record<string, string> = {
      pop: '[POP]',
      reality: '[REALITY]',
      nollywood: '[NOLLY]',
      afrobeats: '[AFRO]',
      music: '[MUSIC]',
    };
    if (subcategory && ENTERTAINMENT_TAG_MAP[subcategory]) {
      base.questionFilter = ENTERTAINMENT_TAG_MAP[subcategory];
    }
  } else if (category === 'economy') {
    base.value = 'economics';
  } else if (category === 'tech') {
    base.value = 'finance';
  } else if (category === 'geo') {
    base.value = 'politics';
  } else {
    base.value = category;
  }

  return base;
}

interface MarketListProps {
  filterExactMarketId?: number;
  filterChildrenOfParentId?: number;
  leagueCode?: string;
}

export function MarketList({ filterExactMarketId, filterChildrenOfParentId, leagueCode }: MarketListProps) {
  const searchParams = useSearchParams();
  const category = searchParams.get('category') || 'trending';
  const subcategory = searchParams.get('subcategory') || null;

  const [markets, setMarkets] = useState<Market[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  const fetchMarkets = useCallback(async () => {
    setIsLoading(true);
    try {
      let query = supabase
        .from('markets')
        .select('id, title, question, category, options, status, closes_at, total_pool, resolved_outcome, parent_market_id, on_chain_market_id, merkle_root')
        .not('status', 'eq', 'voided')
        .order('closes_at', { ascending: true });

      if (filterExactMarketId !== undefined) {
        query = query.eq('id', filterExactMarketId);
      } else if (filterChildrenOfParentId !== undefined) {
        query = query.eq('parent_market_id', filterChildrenOfParentId);
      } else if (leagueCode) {
        query = query
          .is('parent_market_id', null)
          .eq('category', 'sports')
          .ilike('question', `%${leagueCode}%`);
      } else {
        // General market list — top-level only
        query = query.is('parent_market_id', null);

        const { column, value, questionFilter } = buildCategoryFilter(category, subcategory);
        if (value) query = query.eq(column, value);
        if (questionFilter) query = query.ilike('question', `%${questionFilter}%`);
      }

      const { data, error } = await query.limit(50);
      if (error) throw error;
      setMarkets((data || []) as Market[]);
    } catch (err) {
      console.error('Failed to fetch markets:', err);
    } finally {
      setIsLoading(false);
    }
  }, [filterExactMarketId, filterChildrenOfParentId, category, subcategory, leagueCode]);

  useEffect(() => { fetchMarkets(); }, [fetchMarkets]);

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
    return (
      <div className="text-center p-12 border border-muted rounded-xl bg-card/50">
        <p className="text-muted-foreground">
          {filterChildrenOfParentId ? 'No sub-markets for this event.' : 'No markets in this category yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {markets.map(market => (
        <MarketCard
          key={market.id}
          market={market}
          session={session}
          onBetPlaced={fetchMarkets}
          hideViewMore={filterExactMarketId !== undefined || filterChildrenOfParentId !== undefined}
        />
      ))}
    </div>
  );
}
