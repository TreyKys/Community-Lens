'use client';

import { useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, MOCK_USDC_ADDRESS, MOCK_USDC_ABI } from '@/lib/constants';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatUnits, parseUnits } from 'viem';
import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useSearchParams } from 'next/navigation';

const SPORTS_TAGS = ['[PL]', '[PD]', '[SA]', '[BL1]', '[FL1]', '[CL]', '[WC]', '[EC]', '[DED]', '[BSA]', '[PPL]', '[ELC]', '[NBA]'];

interface Market {
    marketId: bigint;
    question: string;
    resolved: boolean;
    voided: boolean;
    totalPool: bigint;
    bettingEndsAt: bigint;
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

export function MarketList() {
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

        const [question, resolved, , voided, totalPool, bettingEndsAt] = result.result as unknown as [string, boolean, bigint, boolean, bigint, bigint, string];

        // 1. Expiry Check
        const isExpired24h = Number(bettingEndsAt) * 1000 + 86400000 < Date.now();
        if (isExpired24h && !resolved) return null;
        if (isExpired24h) return null;

        // 2. Category Filter
        if (category === 'politics') {
             if (!question.includes('[POLITICS]') && !question.includes('[US]') && !question.includes('[NG]')) return null;
        } else if (category === 'crypto') {
             if (!question.includes('[CRYPTO]')) return null;
        } else if (category === 'sports') {
             const isSports = SPORTS_TAGS.some(tag => question.includes(tag));
             if (!isSports) return null;
        }

        return { marketId, question, resolved, voided, totalPool, bettingEndsAt } as Market;
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
            />
          ))
      ) : (
        <div className="text-center text-muted-foreground p-8">
          No markets found for this category.
        </div>
      )}
    </div>
  );
}

function MarketCard({ marketId, question, resolved, voided, totalPool, bettingEndsAt }: {
    marketId: bigint;
    question: string;
    resolved: boolean;
    voided: boolean;
    totalPool: bigint;
    bettingEndsAt: bigint;
}) {
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
        address: MOCK_USDC_ADDRESS as `0x${string}`,
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
        address: MOCK_USDC_ADDRESS as `0x${string}`,
        abi: MOCK_USDC_ABI,
        functionName: 'allowance',
        args: [address as `0x${string}`, TRUTH_MARKET_ADDRESS as `0x${string}`],
        query: {
            enabled: !!address,
        }
    });

    const allowance = allowanceData ? allowanceData : BigInt(0);

    // Approve
    const { writeContract: approve, data: approveHash, isPending: isApprovePending, error: approveError } = useWriteContract();
    const { isSuccess: isApproveSuccess, isLoading: isApproveConfirming } = useWaitForTransactionReceipt({ hash: approveHash });

    // Bet
    const { writeContract: placeBet, data: betHash, isPending: isBetPending, error: betError } = useWriteContract();
    const { isSuccess: isBetSuccess, isLoading: isBetConfirming } = useWaitForTransactionReceipt({ hash: betHash });

    const getParsedAmount = (val: string) => {
        try {
            return parseUnits(val, 18);
        } catch {
            return BigInt(0);
        }
    };

    const handlePlaceBet = () => {
        if (!amount || Number(amount) <= 0) return;
        placeBet({
            address: TRUTH_MARKET_ADDRESS as `0x${string}`,
            abi: TRUTH_MARKET_ABI,
            functionName: 'placeBet',
            args: [marketId, BigInt(selectedOption), getParsedAmount(amount)],
        });
    };

    useEffect(() => {
        if (isApproveSuccess) {
            toast({ title: "Approved!", description: "You can now place your bet." });
            refetchAllowance();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isApproveSuccess]);

    useEffect(() => {
        if (approveError) {
             toast({ title: "Approval Failed", description: approveError.message || "The transaction failed or was dropped. Please try again.", variant: "destructive" });
        }
    }, [approveError, toast]);

    useEffect(() => {
        if (isBetSuccess) {
            toast({ title: "Bet Placed!", description: "Good luck!" });
            setAmount('');
            setIsExpanded(false);
        }
    }, [isBetSuccess, toast]);

    useEffect(() => {
        if (betError) {
             toast({ title: "Error", description: betError.message, variant: "destructive" });
        }
    }, [betError, toast]);

    const handleApprove = () => {
         if (!amount || Number(amount) <= 0) {
            toast({ title: "Invalid Amount", description: "Please enter a valid amount", variant: "destructive" });
            return;
        }

        const betAmount = getParsedAmount(amount);
        if (betAmount > balance) {
            toast({
                title: "Insufficient Balance",
                description: `You have ${formatUnits(balance, 18)} USDC. Use the Wallet to mint Demo tokens.`,
                variant: "destructive"
            });
            return;
        }

        approve({
            address: MOCK_USDC_ADDRESS as `0x${string}`,
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [TRUTH_MARKET_ADDRESS as `0x${string}`, betAmount],
        });
    };

    return (
        <Card className="hover:shadow-lg transition-shadow">
            <CardHeader className="pb-2 cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
              <div className="flex justify-between items-start">
                <CardTitle className="text-lg font-medium">{question}</CardTitle>
                <Badge variant={resolved ? "secondary" : isExpired ? "destructive" : "default"}>
                  {resolved ? "Resolved" : isExpired ? "Closed" : "Live"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex justify-between text-sm text-muted-foreground mt-2">
                <span>Pool: {formatUnits(totalPool, 18)} USDC</span>
                <span>Ends: {endDate.toLocaleString()}</span>
              </div>
              {voided && <div className="text-red-500 text-xs mt-1">Market Voided</div>}

              {isExpanded && (
                  <div className="mt-4 pt-4 border-t space-y-4 animate-in fade-in slide-in-from-top-2">
                      <RadioGroup value={selectedOption} onValueChange={setSelectedOption} className="grid grid-cols-3 gap-2">
                          {options.map((opt, idx) => (
                              <div key={idx}>
                                  <RadioGroupItem value={idx.toString()} id={`m-${marketId}-opt-${idx}`} className="peer sr-only" />
                                  <Label
                                    htmlFor={`m-${marketId}-opt-${idx}`}
                                    className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-2 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
                                  >
                                      {opt}
                                  </Label>
                              </div>
                          ))}
                      </RadioGroup>

                      <div className="flex gap-2">
                          <Input
                            type="number"
                            placeholder="Amount (USDC)"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            disabled={!isLive}
                          />
                          {!isLive ? (
                              <Button disabled>Market Closed</Button>
                          ) : allowance >= (amount ? getParsedAmount(amount) : BigInt(0)) ? (
                              <Button
                                onClick={handlePlaceBet}
                                disabled={isBetPending || isBetConfirming}
                              >
                                  {isBetPending || isBetConfirming ? "Betting..." : "Place Bet"}
                              </Button>
                          ) : (
                              <Button
                                onClick={handleApprove}
                                disabled={isApprovePending || isApproveConfirming}
                              >
                                  {isApprovePending ? "Pending Signature..." : isApproveConfirming ? "Confirming on-chain..." : "Approve"}
                              </Button>
                          )}
                      </div>
                      {address && (
                          <div className="text-xs text-right text-muted-foreground">
                              Balance: {formatUnits(balance, 18)} USDC
                          </div>
                      )}
                  </div>
              )}
            </CardContent>
            {!isExpanded && (
                <CardFooter className="pt-0">
                    <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setIsExpanded(true)}>
                        {isLive ? "Tap to Bet" : "View Options"}
                    </Button>
                </CardFooter>
            )}
        </Card>
    );
}
