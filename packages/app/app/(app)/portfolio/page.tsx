'use client';

import { useAccount } from 'wagmi';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useEffect, useState } from 'react';

export default function PortfolioPage() {
    const { address, isConnected } = useAccount();
    // @ts-ignore
    const [activeBets, setActiveBets] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function fetchUserBets() {
            if (!address) return;

            try {
                const { data, error } = await supabase
                    .from('user_bets')
                    .select('*')
                    .eq('wallet_address', address.toLowerCase())
                    .eq('status', 'Pending')
                    .order('created_at', { ascending: false });

                if (error) throw error;
                if (data) setActiveBets(data);
            } catch (err) {
                console.error("Error fetching user bets:", err);
            } finally {
                setIsLoading(false);
            }
        }

        if (isConnected) {
            fetchUserBets();
        } else {
            setIsLoading(false);
        }
    }, [address, isConnected]);

    if (!isConnected) {
        return (
            <div className="container mx-auto p-8 flex items-center justify-center min-h-[50vh]">
                <p className="text-muted-foreground text-lg">Please sign in to view your open bets.</p>
            </div>
        );
    }

    return (
        <div className="container mx-auto p-4 sm:p-8 font-[family-name:var(--font-geist-sans)] max-w-3xl">
            <h1 className="text-3xl font-bold mb-6 text-foreground">Open Bets</h1>

            {isLoading ? (
                <div className="text-center p-12 border border-muted rounded-xl bg-card/50">
                    <span className="animate-pulse text-muted-foreground uppercase tracking-widest text-sm font-semibold">Loading...</span>
                </div>
            ) : activeBets.length === 0 ? (
                <div className="text-center p-12 border border-muted rounded-xl bg-card/50">
                    <p className="text-muted-foreground text-lg mb-4">You have no active betting slips.</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {activeBets.map((bet) => (
                        <Card key={bet.id} className="bg-card border-muted relative overflow-hidden group">
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start gap-4">
                                    <CardTitle className="text-base font-medium">{bet.market_title}</CardTitle>
                                    <Badge variant="outline">{bet.status}</Badge>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="flex justify-between items-center text-sm">
                                    <div className="flex flex-col">
                                        <span className="text-muted-foreground text-xs uppercase tracking-wider">Staked</span>
                                        <span className="font-semibold text-foreground">₦{Number(bet.staked_amount).toLocaleString()}</span>
                                    </div>
                                    <div className="flex flex-col text-right">
                                        <span className="text-muted-foreground text-xs uppercase tracking-wider">Predicted Option</span>
                                        <span className="font-medium">{bet.outcome}</span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}