'use client';

import { useAccount } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';
import { Download, Clock } from 'lucide-react';

interface UserBet {
    id: string;
    market_id: string;
    market_title: string;
    outcome: string;
    staked_amount: number;
    status: string;
    created_at: string;
}

export default function PortfolioPage() {
    const { address } = useAccount();
    const { toast } = useToast();
    const [bets, setBets] = useState<UserBet[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [userId, setUserId] = useState<string | null>(null);

    useEffect(() => {
        if (!address) return;

        const fetchBets = async () => {
            setIsLoading(true);

            // First get user ID
            const { data: user } = await supabase
                .from('users')
                .select('id')
                .eq('wallet_address', address)
                .single();

            if (user) {
                setUserId(user.id);
                const { data: betsData, error } = await supabase
                    .from('user_bets')
                    .select('*, markets(question)')
                    .eq('user_id', user.id)
                    .order('created_at', { ascending: false });

                if (betsData && !error) {
                    setBets(betsData.map(b => ({
                        ...b,
                        market_title: b.markets?.question || b.market_title
                    })));
                }
            }
            setIsLoading(false);
        };

        fetchBets();
    }, [address]);

    const handleDownloadReceipt = async (marketId: string) => {
        if (!userId) return;

        try {
            const res = await fetch(`/api/markets/${marketId}/proof?userId=${userId}`);
            if (!res.ok) throw new Error('Proof not ready or market not committed.');

            const data = await res.json();

            // Trigger download
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `truthmarket-receipt-${marketId}.json`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);

            toast({
                title: "Receipt Downloaded",
                description: "Your cryptographic proof is saved."
            });

        } catch (error: unknown) {
            toast({
                title: "Download Failed",
                description: error instanceof Error ? error.message : "Unknown error",
                variant: "destructive"
            });
        }
    };

    if (!address) {
        return <div className="p-8 text-center text-muted-foreground">Please connect to view your portfolio.</div>;
    }

    const openBets = bets.filter(b => b.status === 'pending');
    const resolvedBets = bets.filter(b => b.status !== 'pending');

    return (
        <div className="space-y-6 w-full max-w-2xl mx-auto pb-24">
            <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>

            <Tabs defaultValue="open" className="w-full">
                <TabsList className="grid w-full grid-cols-2 bg-muted/50 p-1">
                    <TabsTrigger value="open" className="data-[state=active]:bg-background data-[state=active]:shadow-sm transition-all rounded-md">
                        Open Bets ({openBets.length})
                    </TabsTrigger>
                    <TabsTrigger value="resolved" className="data-[state=active]:bg-background data-[state=active]:shadow-sm transition-all rounded-md">
                        Resolved ({resolvedBets.length})
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="open" className="space-y-4 mt-6">
                    {isLoading ? (
                        <div className="text-center p-8 animate-pulse text-muted-foreground">Loading...</div>
                    ) : openBets.length > 0 ? (
                        openBets.map(bet => (
                            <Card key={bet.id} className="bg-card/50 border-muted">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base leading-tight">{bet.market_title}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex justify-between items-center bg-muted/30 p-3 rounded-md">
                                        <div>
                                            <div className="text-xs text-muted-foreground mb-1">Prediction</div>
                                            <div className="font-medium text-foreground">{bet.outcome}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-xs text-muted-foreground mb-1">Stake</div>
                                            <div className="font-medium text-foreground">₦{bet.staked_amount.toLocaleString()}</div>
                                        </div>
                                    </div>
                                </CardContent>
                                <CardFooter className="pt-0 text-xs text-muted-foreground flex justify-between items-center">
                                    <span className="flex items-center gap-1"><Clock className="w-3 h-3"/> Pending Resolution</span>
                                    <span>{new Date(bet.created_at).toLocaleDateString()}</span>
                                </CardFooter>
                            </Card>
                        ))
                    ) : (
                        <div className="text-center p-12 text-muted-foreground bg-muted/10 rounded-lg border border-dashed border-muted">
                            No open bets. Time to lock in a prediction.
                        </div>
                    )}
                </TabsContent>

                <TabsContent value="resolved" className="space-y-4 mt-6">
                     {isLoading ? (
                        <div className="text-center p-8 animate-pulse text-muted-foreground">Loading...</div>
                    ) : resolvedBets.length > 0 ? (
                        resolvedBets.map(bet => (
                            <Card key={bet.id} className="bg-card/50 border-muted opacity-80 hover:opacity-100 transition-opacity">
                                <CardHeader className="pb-2 flex flex-row items-start justify-between">
                                    <CardTitle className="text-base leading-tight pr-4">{bet.market_title}</CardTitle>
                                    <span className={`text-xs font-bold px-2 py-1 rounded-sm uppercase tracking-wider ${bet.status === 'won' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'}`}>
                                        {bet.status}
                                    </span>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex justify-between items-center">
                                        <div>
                                            <span className="text-muted-foreground text-sm">Prediction: </span>
                                            <span className="font-medium">{bet.outcome}</span>
                                        </div>
                                        <div>
                                            <span className="text-muted-foreground text-sm">Stake: </span>
                                            <span className="font-medium">₦{bet.staked_amount.toLocaleString()}</span>
                                        </div>
                                    </div>
                                </CardContent>
                                <CardFooter className="pt-0 justify-between">
                                    <div className="text-xs text-muted-foreground">{new Date(bet.created_at).toLocaleDateString()}</div>
                                    <Button variant="outline" size="sm" onClick={() => handleDownloadReceipt(bet.market_id)} className="h-8 text-xs bg-muted/20 hover:bg-muted/50 border-muted">
                                        <Download className="w-3 h-3 mr-2" /> Receipt
                                    </Button>
                                </CardFooter>
                            </Card>
                        ))
                    ) : (
                        <div className="text-center p-12 text-muted-foreground bg-muted/10 rounded-lg border border-dashed border-muted">
                            No resolved bets yet.
                        </div>
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}
