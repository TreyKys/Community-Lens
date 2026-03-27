'use client';

import { useAccount } from 'wagmi';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bets, setBets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchBets() {
      if (!address) return;
      try {
        const { data } = await supabase
          .from('user_bets')
          .select('*')
          .eq('wallet_address', address)
          .eq('status', 'Pending')
          .order('created_at', { ascending: false });

        if (data) setBets(data);
      } catch (err) {
        console.error("Failed to fetch bets:", err);
      } finally {
        setLoading(false);
      }
    }

    if (isConnected) {
        fetchBets();
    } else {
        setLoading(false);
    }
  }, [address, isConnected]);

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center space-y-4">
        <h2 className="text-2xl font-bold">Open Bets</h2>
        <p className="text-muted-foreground max-w-sm">
          Connect your wallet to view your active predictions and bet receipts.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Open Bets</h1>
        <p className="text-muted-foreground mt-2">Manage your active predictions and bet receipts.</p>
      </div>

      {loading ? (
        <div className="flex justify-center p-8">
            <span className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
        </div>
      ) : bets.length === 0 ? (
        <Card className="bg-card/50 backdrop-blur-sm border-muted border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center space-y-4">
            <div className="p-4 bg-muted/50 rounded-full">
              <span className="text-2xl">📋</span>
            </div>
            <div className="space-y-1">
              <h3 className="font-medium text-lg">No Active Predictions</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                You don&apos;t have any open bets at the moment. Explore the markets to lock in your predictions.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {bets.map((bet) => (
            <Card key={bet.id} className="hover:shadow-md transition-shadow bg-card border-muted relative overflow-hidden">
              <CardContent className="p-6 relative z-10">
                <div className="flex justify-between items-start">
                  <div className="space-y-2">
                    <Badge variant="outline" className="bg-muted/50">Bet Receipt</Badge>
                    <h3 className="font-semibold text-lg">{bet.market_title}</h3>
                    <p className="text-sm text-muted-foreground flex items-center gap-2">
                        Prediction: <Badge variant="secondary">{bet.outcome}</Badge>
                    </p>
                  </div>
                  <div className="text-right space-y-2 flex flex-col items-end">
                    <div className="font-medium text-xl">₦{bet.staked_amount.toLocaleString()}</div>
                    <Badge variant="open" className="animate-pulse">Active</Badge>
                  </div>
                </div>
              </CardContent>
              {/* Subtle accent line matching 'Active' open status */}
              <div className="absolute bottom-0 left-0 h-1 bg-emerald-500/50 w-full" />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
