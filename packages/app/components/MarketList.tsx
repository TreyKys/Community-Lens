'use client';

import { useReadContract, useReadContracts } from 'wagmi';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from '@/lib/constants';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUnits } from 'viem';

export function MarketList() {
  const { data: nextId } = useReadContract({
    address: TRUTH_MARKET_ADDRESS as `0x${string}`,
    abi: TRUTH_MARKET_ABI,
    functionName: 'nextMarketId',
  });

  const count = nextId ? Number(nextId) : 0;
  // Create array of IDs in reverse order (newest first)
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
        const isExpired = Number(bettingEndsAt) * 1000 < Date.now();
        const endDate = new Date(Number(bettingEndsAt) * 1000);

        return (
          <Card key={marketId.toString()} className="hover:shadow-lg transition-shadow">
            <CardHeader className="pb-2">
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
            </CardContent>
          </Card>
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
