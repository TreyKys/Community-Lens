'use client';

import { useReadContract, useReadContracts, useAccount } from 'wagmi';
import { useSendCalls, useCallsStatus } from 'wagmi/experimental';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, TNGN_ADDRESS, TNGN_ABI } from '@/lib/constants';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Drawer, DrawerContent, DrawerTrigger, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose } from '@/components/ui/drawer';
import { formatUnits, parseUnits } from 'viem';
import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSearchParams, useRouter } from 'next/navigation';

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

const ERC20_APPROVE_ABI = [{
    inputs: [
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function"
}] as const;

const ERC20_BALANCE_ABI = [{
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
}] as const;

export function MarketList({ filterExactMarketId, filterChildrenOfParentId }: { filterExactMarketId?: bigint, filterChildrenOfParentId?: bigint }) {
  const searchParams = useSearchParams();
  const category = searchParams.get('category') || 'all';

  const { data: nextId } = useReadContract({
    address: TRUTH_MARKET_ADDRESS as `0x${string}`,
    abi: TRUTH_MARKET_ABI,
    functionName: 'nextMarketId',
  });

  const count = nextId ? Number(nextId) : 0;
  const marketIds = Array.from({ length: count }, (_, i) => BigInt(count - 1 - i));

  const { data: markets, isLoading: isMarketsLoading } = useReadContracts({
    contracts: marketIds.map((id) => ({
      address: TRUTH_MARKET_ADDRESS as `0x${string}`,
      abi: TRUTH_MARKET_ABI,
      functionName: 'markets',
      args: [id],
    })),
  });

  if (nextId === undefined || (count > 0 && isMarketsLoading)) {
      return <div className="p-8 text-center">Loading markets...</div>;
  }

  const filteredMarkets = (markets || []).map((result, index) => {
        const marketId = marketIds[index];
        if (result.status !== 'success' || !result.result) return null;

        // market: [question, resolved, winningOptionIndex, voided, totalPool, bettingEndsAt, creator, parentMarketId]
        const [question, resolved, , voided, totalPool, bettingEndsAt, , parentMarketId] = result.result as unknown as [string, boolean, bigint, boolean, bigint, bigint, string, bigint];

        // 1. Expiry Check
        const isExpired24h = Number(bettingEndsAt) * 1000 + 86400000 < Date.now();
        if (isExpired24h && !resolved) return null;
        if (isExpired24h) return null;

        if (filterExactMarketId !== undefined) {
             // Specific view: Only show this exact market (used for pinning parent)
             if (marketId !== filterExactMarketId) return null;
        } else if (filterChildrenOfParentId !== undefined) {
             // Specific view: Only show children of this parent
             if (parentMarketId !== filterChildrenOfParentId) return null;
        } else {
             // General view: Only show Parent Markets (parentMarketId == 0)
             if (Number(parentMarketId) !== 0) return null;

             // Category Filter (only on general view)
             if (category === 'politics') {
                  if (!question.includes('[POLITICS]') && !question.includes('[US]') && !question.includes('[NG]')) return null;
             } else if (category === 'crypto') {
                  if (!question.includes('[CRYPTO]')) return null;
             } else if (category === 'sports') {
                  const isSports = SPORTS_TAGS.some(tag => question.includes(tag));
                  if (!isSports) return null;
             }
        }

        return { marketId, question, resolved, voided, totalPool, bettingEndsAt, parentMarketId } as Market;
  }).filter((m): m is Market => m !== null);

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
    const { address } = useAccount();
    const { toast } = useToast();
    const [selectedOption, setSelectedOption] = useState<string>('0');
    const [amount, setAmount] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);

    const { data: optionsData } = useReadContract({
        address: TRUTH_MARKET_ADDRESS as `0x${string}`,
        abi: TRUTH_MARKET_ABI,
        functionName: 'getMarketOptions',
        args: [marketId],
    });

    const options = optionsData ? (optionsData as string[]) : [];

    const isExpired = Number(bettingEndsAt) * 1000 < Date.now();
    const endDate = new Date(Number(bettingEndsAt) * 1000);
    const isLive = !resolved && !voided && !isExpired;

    // Check Balance
    const { data: balanceData } = useReadContract({
        address: TNGN_ADDRESS as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
        query: {
            enabled: !!address,
        }
    });

    const balance = balanceData ? balanceData : BigInt(0);

    // Check Allowance
    const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
        address: TNGN_ADDRESS as `0x${string}`,
        abi: TNGN_ABI,
        functionName: 'allowance',
        args: [address as `0x${string}`, TRUTH_MARKET_ADDRESS as `0x${string}`],
        query: {
            enabled: !!address,
        }
    });

    const allowance = allowanceData ? allowanceData : BigInt(0);

    const getParsedAmount = (val: string) => {
        try {
            return parseUnits(val, 18);
        } catch {
            return BigInt(0);
        }
    };

    // ERC-4337 Batching for Smart Wallets
    const { sendCalls, data: callsIdData, isPending: isBatchPending } = useSendCalls({
        mutation: {
            onError: (error) => {
                toast({ title: "Transaction Failed", description: error.message, variant: "destructive" });
            }
        }
    });

    // wagmi v2 sends back an object with an id string
    const _callsId: string = typeof callsIdData === 'string' ? callsIdData : ((callsIdData as unknown) as { id?: string })?.id || "";

    const { data: callsStatus } = useCallsStatus({ id: _callsId, query: { enabled: !!_callsId } });

    useEffect(() => {
        if (callsStatus?.status === 'success') {
            toast({ title: "Prediction Locked!", description: "Check your profile for the Bet Receipt." });
            setAmount('');
            setIsExpanded(false);
            refetchAllowance();
        }
    }, [callsStatus?.status, toast, refetchAllowance]);

    const handlePlaceBatchedBet = () => {
         if (!amount || Number(amount) <= 0) {
            toast({ title: "Invalid Amount", description: "Please enter a valid amount", variant: "destructive" });
            return;
        }

        const betAmount = getParsedAmount(amount);
        if (betAmount > balance) {
            toast({
                title: "Insufficient Balance",
                description: `You have ₦${Number(formatUnits(balance, 18)).toLocaleString()}. Use the Wallet to Deposit Naira.`,
                variant: "destructive"
            });
            return;
        }

        const needsApproval = allowance < betAmount;

        const calls = [];

        if (needsApproval) {
            calls.push({
                to: TNGN_ADDRESS as `0x${string}`,
                abi: ERC20_APPROVE_ABI,
                functionName: 'approve',
                args: [TRUTH_MARKET_ADDRESS as `0x${string}`, betAmount]
            });
        }

        calls.push({
            to: TRUTH_MARKET_ADDRESS as `0x${string}`,
            abi: TRUTH_MARKET_ABI,
            functionName: 'placeBet',
            args: [marketId, BigInt(selectedOption), betAmount]
        });

        sendCalls({
            calls,
            capabilities: {
                paymasterService: {
                    url: '/api/paymaster'
                }
            }
        });
    };

    const isBettingLoading = isBatchPending || callsStatus?.status === 'pending';

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
                      disabled={!isLive}
                      className="pl-8 bg-transparent"
                    />
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
                </div>

                {!isLive ? (
                    <Button disabled className="w-full">Market Closed</Button>
                ) : (
                    <Button
                      onClick={handlePlaceBatchedBet}
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
            {address && (
                <div className="text-xs text-right text-muted-foreground">
                    Balance: ₦{Number(formatUnits(balance, 18)).toLocaleString()}
                </div>
            )}
        </div>
    );

    return (
        <Card className="hover:shadow-lg transition-shadow bg-card relative overflow-hidden group border-muted">
            {/* Subtle Gradient Highlights */}
            <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/5 via-transparent to-red-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

            <CardHeader className="pb-2 relative z-10">
              <div className="flex justify-between items-start">
                <CardTitle className="text-lg font-medium tracking-tight text-foreground">{question.replace(/\[.*?\]\s*/g, '')}</CardTitle>
                <Badge variant={resolved ? "secondary" : isExpired ? "destructive" : "open"}>
                  {resolved ? "Resolved" : isExpired ? "Closed" : "Open"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
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
                            {isLive ? "Predict" : "View Options"}
                        </Button>
                    )}
                </div>

                <div className="md:hidden w-full">
                    <Drawer open={isExpanded} onOpenChange={setIsExpanded}>
                        <DrawerTrigger asChild>
                            <Button variant="ghost" size="sm" className="w-full text-xs bg-muted/20 hover:bg-muted/50">
                                {isLive ? "Tap to Predict" : "View Options"}
                            </Button>
                        </DrawerTrigger>
                        <DrawerContent>
                            <div className="mx-auto w-full max-w-sm">
                                <DrawerHeader>
                                    <DrawerTitle>{question.replace(/\[.*?\]\s*/g, '')}</DrawerTitle>
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
