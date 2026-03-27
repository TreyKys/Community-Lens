'use client';

import { useAccount } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { useReadContract } from 'wagmi';
import { TNGN_ADDRESS } from '@/lib/constants';
import { formatUnits } from 'viem';

export default function ProfilePage() {
  const { address, isConnected } = useAccount();
  const [bonusBalance, setBonusBalance] = useState<number>(0);

  const { data: balanceData } = useReadContract({
      address: TNGN_ADDRESS as `0x${string}`,
      abi: [{
          inputs: [{ name: "account", type: "address" }],
          name: "balanceOf",
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function"
      }],
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
      query: {
          enabled: !!address,
      }
  });

  const balance = balanceData ? Number(formatUnits(balanceData as bigint, 18)) : 0;

  useEffect(() => {
    async function fetchBonusBalance() {
      if (!address) return;
      try {
        const { data } = await supabase
            .from('users')
            .select('bonus_balance')
            .eq('walletAddress', address.toLowerCase())
            .single();

        if (data && data.bonus_balance) {
            setBonusBalance(data.bonus_balance);
        }
      } catch (err) {
        console.error("Failed to fetch bonus balance:", err);
      }
    }

    if (isConnected) {
        fetchBonusBalance();
    }
  }, [address, isConnected]);

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center space-y-4">
        <h2 className="text-2xl font-bold">Profile</h2>
        <p className="text-muted-foreground max-w-sm">
          Sign In to view your wallet balance and account details.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground mt-2">Manage your account and deposits.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-card">
          <CardHeader>
            <CardTitle>Wallet Balance</CardTitle>
            <CardDescription>Your tNGN balance for predictions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-4xl font-bold">₦{balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>

            <WalletModal triggerText="Deposit Naira" className="w-full font-semibold" />
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-amber-500/20">
          <CardHeader>
            <CardTitle className="text-amber-500 flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
              </span>
              Bonus Balance
            </CardTitle>
            <CardDescription className="text-amber-500/80">Rewards and promotional tNGN</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold text-amber-500">₦{bonusBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <p className="text-sm text-amber-500/80 mt-2">
              Use bonus tNGN to place predictions without touching your principal balance.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-sm font-medium text-muted-foreground">Connected Wallet</div>
            <div className="font-mono text-sm break-all bg-muted p-2 rounded-md mt-1">{address}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
