'use client';

import { useAccount, useReadContract } from 'wagmi';
import { TNGN_ADDRESS, TNGN_ABI } from '@/lib/constants';
import { supabase } from '@/lib/supabase';
import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { WalletModal } from '@/components/WalletModal';
import { Coins, PiggyBank } from 'lucide-react';

export default function ProfilePage() {
    const { address, isConnected } = useAccount();
    const [bonusBalance, setBonusBalance] = useState<number>(0);

    const { data: balanceData } = useReadContract({
        address: TNGN_ADDRESS as `0x${string}`,
        abi: TNGN_ABI,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
        query: {
            enabled: !!address,
        }
    });

    const balance = balanceData ? (balanceData as bigint) : BigInt(0);

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

    if (!isConnected) {
        return (
            <div className="container mx-auto p-8 flex items-center justify-center min-h-[50vh]">
                <p className="text-muted-foreground text-lg">Please sign in to view your profile.</p>
            </div>
        );
    }

    return (
        <div className="container mx-auto p-4 sm:p-8 font-[family-name:var(--font-geist-sans)] max-w-4xl">
            <h1 className="text-3xl font-bold mb-8 text-foreground">Wallet Dashboard</h1>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card className="bg-gradient-to-br from-card to-card/50 border-muted">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-xl font-medium tracking-tight">
                            <Coins className="w-5 h-5 text-primary" />
                            Wallet Balance
                        </CardTitle>
                        <CardDescription>Your total available tNGN</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="text-4xl font-bold tracking-tighter mb-6 mt-2">
                            ₦{Number(formatUnits(balance, 18)).toLocaleString()}
                        </div>
                        <div className="w-full">
                            <WalletModal />
                        </div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/5 border-amber-500/20">
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-xl font-medium tracking-tight text-amber-500">
                            <PiggyBank className="w-5 h-5" />
                            Bonus Balance
                        </CardTitle>
                        <CardDescription>Your 1% betting credits</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="text-4xl font-bold tracking-tighter text-amber-500 mb-6 mt-2">
                            ₦{bonusBalance.toLocaleString()}
                        </div>
                        <Button disabled variant="outline" className="w-full border-amber-500/30 text-amber-500/50 cursor-not-allowed">
                            Automatically Applied
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}