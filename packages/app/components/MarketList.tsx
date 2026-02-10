'use client';

import { useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, MOCK_USDC_ADDRESS } from '@/lib/constants';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatUnits, parseUnits } from 'viem';
import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';

export function MarketList() {
  const { data: nextId } = useReadContract({
    address: TRUTH_MARKET_ADDRESS as `0x${string}`,
    abi: TRUTH_MARKET_ABI,
    functionName: 'nextMarketId',
  });

  const count = nextId ? Number(nextId) : 0;
  const marketIds = Array.from({ length: count }, (_, i) => BigInt(count - 1 - i));

  const { data: markets } = useReadContracts({
    contracts: marketIds.map((id) => ({
      address: TRUTH_MARKET_ADDRESS as `0x${string}`,
      abi: TRUTH_MARKET_ABI,
      functionName: 'markets',
      args: [id],
    })),
  });

  if (!markets) return <div className="p-8 text-center">Loading markets...</div>;

  return (
    <div className="space-y-4 w-full max-w-2xl">
      {markets.map((result, index) => {
        const marketId = marketIds[index];
        if (result.status !== 'success' || !result.result) return null;

        const [question, resolved, , voided, totalPool, bettingEndsAt] = result.result as unknown as [string, boolean, bigint, boolean, bigint, bigint];

        return (
          <MarketCard
            key={marketId.toString()}
            marketId={marketId}
            question={question}
            resolved={resolved}
            voided={voided}
            totalPool={totalPool}
            bettingEndsAt={bettingEndsAt}
          />
        );
      })}
      {count === 0 && (
        <div className="text-center text-muted-foreground p-8">
          No markets available yet. Check back soon!
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
    const { toast } = useToast();
    const [selectedOption, setSelectedOption] = useState<string>('0');
    const [amount, setAmount] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);

    // Hardcoded options as per bot logic (Home, Away, Draw)
    // In a full implementation, we'd fetch options from the contract too if the getter supported it
    // But since the standard getter doesn't return the array, and we know the bot format:
    const options = ["Home Win", "Away Win", "Draw"];

    const isExpired = Number(bettingEndsAt) * 1000 < Date.now();
    const endDate = new Date(Number(bettingEndsAt) * 1000);
    const isLive = !resolved && !voided && !isExpired;

    // Approve
    const { writeContract: approve, data: approveHash, isPending: isApprovePending } = useWriteContract();
    const { isSuccess: isApproveSuccess, isLoading: isApproveConfirming } = useWaitForTransactionReceipt({ hash: approveHash });

    // Bet
    const { writeContract: placeBet, data: betHash, isPending: isBetPending, error: betError } = useWriteContract();
    const { isSuccess: isBetSuccess, isLoading: isBetConfirming } = useWaitForTransactionReceipt({ hash: betHash });

    const handlePlaceBet = () => {
        if (!amount || Number(amount) <= 0) return;
        placeBet({
            address: TRUTH_MARKET_ADDRESS as `0x${string}`,
            abi: TRUTH_MARKET_ABI,
            functionName: 'placeBet',
            args: [marketId, BigInt(selectedOption), parseUnits(amount, 18)]
        });
    };

    useEffect(() => {
        if (isApproveSuccess) {
            toast({ title: "Approved!", description: "Placing bet now..." });
            handlePlaceBet();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isApproveSuccess]);

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

    const handleAction = () => {
         if (!amount || Number(amount) <= 0) {
            toast({ title: "Invalid Amount", description: "Please enter a valid amount", variant: "destructive" });
            return;
        }

        // For UX simplicity in this task, I'll do a two-step process:
        // 1. User clicks "Approve" (if needed) - Hard to know without reading allowance.
        // 2. User clicks "Bet".
        // To keep it simple: I will just try to Approve every time before betting, or just Bet.
        // Let's do Approve then Bet in the effect.

        approve({
            address: MOCK_USDC_ADDRESS as `0x${string}`,
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [TRUTH_MARKET_ADDRESS as `0x${string}`, parseUnits(amount, 18)]
        });
    };

    return (
        <Card className="hover:shadow-lg transition-shadow">
            <CardHeader className="pb-2 cursor-pointer" onClick={() => isLive && setIsExpanded(!isExpanded)}>
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
                          />
                          <Button
                            onClick={handleAction}
                            disabled={isApprovePending || isApproveConfirming || isBetPending || isBetConfirming}
                          >
                              {isApprovePending || isApproveConfirming ? "Approving..." :
                               isBetPending || isBetConfirming ? "Betting..." : "Place Bet"}
                          </Button>
                      </div>
                  </div>
              )}
            </CardContent>
            {!isExpanded && isLive && (
                <CardFooter className="pt-0">
                    <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setIsExpanded(true)}>
                        Tap to Bet
                    </Button>
                </CardFooter>
            )}
        </Card>
    );
}
