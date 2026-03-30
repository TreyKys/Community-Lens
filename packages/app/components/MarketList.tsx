'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Drawer, DrawerContent, DrawerTrigger, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from '@/components/ui/drawer';
import { formatUnits } from 'viem';
import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSearchParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useUser } from '@/components/UserContext';

const SPORTS_TAGS = ['[PL]', '[PD]', '[SA]', '[BL1]', '[FL1]', '[CL]', '[WC]', '[EC]', '[DED]', '[BSA]', '[PPL]', '[ELC]', '[NBA]'];

interface Market {
    marketId: bigint;
    question: string;
    resolved: boolean;
    voided: boolean;
    totalPool: bigint;
    bettingEndsAt: bigint;
    parentMarketId: bigint;
}

export function MarketList({ filterExactMarketId, filterChildrenOfParentId }: { filterExactMarketId?: bigint, filterChildrenOfParentId?: bigint }) {
  const searchParams = useSearchParams();
  const category = searchParams.get('category') || 'all';
  const tag = searchParams.get('tag');

  const [markets, setMarkets] = useState<Market[]>([]);
  const [isMarketsLoading, setIsMarketsLoading] = useState(true);

  // Hybrid Pivot: Fetch strictly from Supabase Off-Chain `markets` table
  useEffect(() => {
      const fetchMarkets = async () => {
          setIsMarketsLoading(true);
          const { data, error } = await supabase
              .from('markets')
              .select('*')
              .order('created_at', { ascending: false });

          if (!error && data) {
              const mapped = data.map(m => ({
                  marketId: BigInt(m.id),
                  question: m.question,
                  resolved: m.status === 'resolved',
                  voided: false, // Default to false until we implement void logic fully off-chain
                  totalPool: BigInt(0), // Would need aggregate logic, using default for now
                  bettingEndsAt: BigInt(Math.floor(new Date(m.closes_at).getTime() / 1000)),
                  parentMarketId: BigInt(0) // Default 0 for demo
              }));
              setMarkets(mapped);
          }
          setIsMarketsLoading(false);
      };

      fetchMarkets();
  }, []);

  if (isMarketsLoading) {
      return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading markets...</div>;
  }

  const filteredMarkets = markets.filter((m) => {
        // Expiry Check
        const isExpired24h = Number(m.bettingEndsAt) * 1000 + 86400000 < Date.now();
        if (isExpired24h && !m.resolved) return false;
        if (isExpired24h) return false;

        if (filterExactMarketId !== undefined) {
             // Specific view: Only show this exact market (used for pinning parent)
             if (m.marketId !== filterExactMarketId) return false;
        } else if (filterChildrenOfParentId !== undefined) {
             // Specific view: Only show children of this parent
             if (m.parentMarketId !== filterChildrenOfParentId) return false;
        } else {
             // General view: Only show Parent Markets (parentMarketId == 0)
             if (Number(m.parentMarketId) !== 0) return false;

             // Mandatory Tag Filtering (e.g. ?tag=[PL])
             if (tag && !m.question.includes(tag)) {
                  return false;
             }

             // Category Filter (only on general view if no specific tag)
             if (!tag) {
                 if (category === 'politics') {
                      if (!m.question.includes('[POLITICS]') && !m.question.includes('[US]') && !m.question.includes('[NG]')) return false;
                 } else if (category === 'crypto') {
                      if (!m.question.includes('[CRYPTO]')) return false;
                 } else if (category === 'sports') {
                      const isSports = SPORTS_TAGS.some(t => m.question.includes(t));
                      if (!isSports) return false;
                 }
             }
        }

        return true;
  });

  return (
    <div className="space-y-4 w-full max-w-2xl">
      {filteredMarkets.length > 0 ? (
          filteredMarkets.map((m) => (
            <MarketCard
                key={m.marketId.toString()}
                marketId={m.marketId}
                question={m.question}
                resolved={m.resolved}
                voided={m.voided}
                totalPool={m.totalPool}
                bettingEndsAt={m.bettingEndsAt}
                parentMarketId={m.parentMarketId}
                hideViewMore={filterExactMarketId !== undefined || filterChildrenOfParentId !== undefined}
            />
          ))
      ) : (
        <div className="text-center text-muted-foreground p-8">
          No markets found.
        </div>
      )}
    </div>
  );
}

export function MarketCard({ marketId, question, resolved, voided, totalPool, bettingEndsAt, parentMarketId, hideViewMore }: {
    marketId: bigint;
    question: string;
    resolved: boolean;
    voided: boolean;
    totalPool: bigint;
    bettingEndsAt: bigint;
    parentMarketId?: bigint;
    hideViewMore?: boolean;
}) {
    const router = useRouter();
    const { toast } = useToast();
    const [selectedOption, setSelectedOption] = useState<string>('0');
    const [amount, setAmount] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);

    const [options, setOptions] = useState<string[]>(['Yes', 'No']);

    useEffect(() => {
        const fetchOptions = async () => {
             const { data } = await supabase.from('markets').select('options').eq('id', marketId.toString()).single();
             if (data && data.options && Array.isArray(data.options)) {
                  setOptions(data.options);
             }
        };
        fetchOptions();
    }, [marketId]);

    const currentTime = Date.now();
    const endsAtMs = Number(bettingEndsAt) * 1000;
    const isExpired = endsAtMs < currentTime;
    const endDate = new Date(endsAtMs);

    // Automation: If currentTime >= deadline and not resolved, it's live.
    // However, the button freeze (can't bet anymore) must use isExpired, wait, the instruction says:
    // If currentTime >= deadline && !isResolved, automatically render the pulsing red "Live" badge.
    // "However, the 'Place Bet' button is hard-disabled and displays 'Market Closed' to prevent execution reverts caused by the contract's deadline requirement."
    const isLive = endsAtMs <= currentTime && !resolved;

    const canBet = !resolved && !voided && !isExpired;

    // Hybrid Settlement Pivot: Fetch off-chain Supabase balance for default OTP users.
    const queryClient = useQueryClient();
    const { user, refreshUser } = useUser();

    // N+1 Fix: Read directly from UserContext
    const offChainBalance = user?.tngn_balance ?? 0;

    // Hybrid Settlement Pivot: Off-chain mutation via React Query
    const placeBetMutation = useMutation({
        mutationFn: async (betData: { userId: string; marketId: string; outcome: string; amount: number }) => {
            const response = await fetch('/api/bet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(betData),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to place bet');
            }

            return response.json();
        },
        onError: (err) => {
            toast({ title: "Prediction Failed", description: err.message, variant: "destructive" });
        },
        onSuccess: async () => {
            toast({ title: "Prediction Locked!", description: "Check your portfolio for the Bet Receipt." });
            await refreshUser();
            setAmount('');
            setIsExpanded(false);

            queryClient.invalidateQueries({ queryKey: ['user_bets'] });
        }
    });

    const handlePlaceBet = () => {
         if (!amount || Number(amount) <= 0) {
            toast({ title: "Invalid Amount", description: "Please enter a valid amount", variant: "destructive" });
            return;
        }

        const numericAmount = Number(amount);

        if (!user || !user.id) {
            toast({ title: "Sign in required", description: "Please sign in to place a prediction.", variant: "destructive" });
            return;
        }

        if (numericAmount > offChainBalance) {
            toast({
                title: "Insufficient Balance",
                description: `You have ₦${offChainBalance.toLocaleString()}. Deposit Naira to continue.`,
                variant: "destructive"
            });
            return;
        }

        const outcomeStr = options[Number(selectedOption)] || 'Unknown';

        placeBetMutation.mutate({
            userId: user.id,
            marketId: marketId.toString(),
            outcome: outcomeStr,
            amount: numericAmount,
        });
    };

    const isBettingLoading = placeBetMutation.isPending;

    const bettingInterface = (
        <div className="mt-4 pt-4 border-t border-muted/50 space-y-4 animate-in fade-in slide-in-from-top-2 relative z-10">
            <RadioGroup value={selectedOption} onValueChange={setSelectedOption} className="grid grid-cols-3 gap-2">
                {options.map((opt, idx) => {
                    // Polymarket-style styling: Soft blue for Yes/Home/Over, Soft Red for No/Away/Under, Neutral for Draw
                    const isBlue = opt.toLowerCase().includes('yes') || opt.toLowerCase().includes('home') || opt.toLowerCase().includes('over');
                    const isRed = opt.toLowerCase().includes('no') || opt.toLowerCase().includes('away') || opt.toLowerCase().includes('under');
                    const gradientClass = isBlue
                      ? "peer-data-[state=checked]:bg-blue-500/10 peer-data-[state=checked]:border-blue-500/50 hover:border-blue-500/30"
                      : isRed
                      ? "peer-data-[state=checked]:bg-red-500/10 peer-data-[state=checked]:border-red-500/50 hover:border-red-500/30"
                      : "peer-data-[state=checked]:bg-primary/10 peer-data-[state=checked]:border-primary hover:border-primary/50";

                    return (
                        <div key={idx}>
                            <RadioGroupItem value={idx.toString()} id={`m-${marketId}-opt-${idx}`} className="peer sr-only" />
                            <Label
                              htmlFor={`m-${marketId}-opt-${idx}`}
                              className={`flex flex-col items-center justify-between rounded-md border border-muted bg-popover/50 p-3 hover:bg-accent hover:text-accent-foreground transition-all cursor-pointer ${gradientClass}`}
                            >
                                <span className="font-medium text-sm">{opt}</span>
                            </Label>
                        </div>
                    );
                })}
            </RadioGroup>

            <div className="flex flex-col gap-4">
                <div className="relative">
                    <Input
                      type="number"
                      placeholder="Amount (₦)"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={!canBet}
                      className="pl-8 bg-transparent"
                    />
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
                </div>

                {!canBet ? (
                    <Button disabled className="w-full">Market Closed</Button>
                ) : (
                    <Button
                      onClick={handlePlaceBet}
                      disabled={isBettingLoading || !amount}
                      className="w-full bg-foreground text-background hover:bg-foreground/90 transition-all font-semibold relative overflow-hidden"
                    >
                        {isBettingLoading ? (
                            <span className="flex items-center gap-2">
                                <span className="animate-spin rounded-full h-4 w-4 border-2 border-background border-t-transparent" />
                                Locking...
                            </span>
                        ) : "Lock Prediction"}
                    </Button>
                )}
            </div>
            {user && (
                <div className="text-xs text-right text-muted-foreground">
                    Balance: ₦{offChainBalance.toLocaleString()}
                </div>
            )}
        </div>
    );

    // Regex formatting to strip bot tags like [BSA]
    let formattedQuestion = question.replace(/\[.*?\]\s*/g, '');

    // Strip redundant parent event names from child market cards
    if (Number(parentMarketId) !== 0) {
        // Assume format is "Arsenal vs Chelsea (Match Winner)"
        const match = formattedQuestion.match(/\(([^)]+)\)$/);
        if (match) {
            formattedQuestion = match[1];
        }
    }

    // Momentum Bar Logic (Mocking percentages for now since pool per option isn't exposed easily on-chain without indexing)
    // We will use a visual representation based on a hash of the market ID to keep it deterministic for the demo,
    // but in production, this should pull from a Supabase indexing table showing exact split.
    // For now: Neutral if pool is 0.
    const hasVolume = totalPool > BigInt(0);
    const mockBlueSplit = hasVolume ? (Number(marketId) % 100) : 50;
    const mockRedSplit = 100 - mockBlueSplit;

    return (
        <Card className="hover:shadow-lg transition-shadow bg-card relative overflow-hidden group border-muted">
            {/* Subtle Gradient Highlights */}
            <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/5 via-transparent to-red-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

            <CardHeader className="pb-2 relative z-10">
              <div className="flex justify-between items-start">
                <CardTitle className="text-lg font-medium tracking-tight text-foreground">{formattedQuestion}</CardTitle>
                <Badge variant={resolved ? "secondary" : isLive ? "live" : isExpired ? "destructive" : "open"}>
                  {resolved ? "RESOLVED" : isLive ? "LIVE" : isExpired ? "CLOSED" : "OPEN"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {/* Momentum Bar */}
              <div className="mt-1 mb-3">
                  <div className="h-3 w-full bg-muted/50 rounded-full overflow-hidden flex relative">
                      {hasVolume ? (
                          <>
                              <div className="h-full bg-blue-500/80 transition-all duration-500" style={{ width: `${mockBlueSplit}%` }} />
                              <div className="h-full bg-red-500/80 transition-all duration-500" style={{ width: `${mockRedSplit}%` }} />
                          </>
                      ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-muted-foreground uppercase tracking-widest z-10">
                              No Predictions Yet
                          </div>
                      )}
                  </div>
              </div>

              <div className="flex justify-between text-sm text-muted-foreground mt-2 relative z-10">
                <span>Pool: ₦{Number(formatUnits(totalPool, 18)).toLocaleString()}</span>
                <span>Ends: {endDate.toLocaleDateString()} {endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              {voided && <div className="text-red-500 text-xs mt-1">Market Voided</div>}

              <div className="hidden md:block">
                  {isExpanded && bettingInterface}
              </div>
            </CardContent>

            <CardFooter className="pt-0 flex gap-2 relative z-10">
                <div className="hidden md:block w-full">
                    {!isExpanded && (
                        <Button variant="ghost" size="sm" className="w-full text-xs bg-muted/20 hover:bg-muted/50" onClick={(e) => {
                            e.stopPropagation();
                            setIsExpanded(true);
                        }}>
                                {canBet ? "Lock Prediction" : "View Options"}
                        </Button>
                    )}
                </div>

                <div className="md:hidden w-full">
                    <Drawer open={isExpanded} onOpenChange={setIsExpanded}>
                        <DrawerTrigger asChild>
                            <Button variant="ghost" size="sm" className="w-full text-xs bg-muted/20 hover:bg-muted/50">
                                    {canBet ? "Tap to Lock Prediction" : "View Options"}
                            </Button>
                        </DrawerTrigger>
                        <DrawerContent>
                            <div className="mx-auto w-full max-w-sm">
                                <DrawerHeader>
                                        <DrawerTitle>{formattedQuestion}</DrawerTitle>
                                    <DrawerDescription>Make your prediction below</DrawerDescription>
                                </DrawerHeader>
                                <div className="p-4 pb-0">
                                    {bettingInterface}
                                </div>
                                <DrawerFooter>
                                    <DrawerClose asChild>
                                        <Button variant="outline">Cancel</Button>
                                    </DrawerClose>
                                </DrawerFooter>
                            </div>
                        </DrawerContent>
                    </Drawer>
                </div>

                {!hideViewMore && Number(parentMarketId) === 0 && (
                    <Button variant="outline" size="sm" className="w-full text-xs" onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/event/${marketId.toString()}`);
                    }}>
                        View More Markets
                    </Button>
                )}
            </CardFooter>
        </Card>
    );
}
