'use client';

import { useAccount } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';
import { WalletIcon, ArrowDownCircle, ArrowUpCircle, History, Trophy, Share2 } from 'lucide-react';
import { formatUnits } from 'viem';
import { TNGN_ADDRESS } from '@/lib/constants';
import { useReadContract } from 'wagmi';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface UserBet {
    id: string;
    market_title: string;
    outcome: string;
    staked_amount: number;
    status: string;
    created_at: string;
}

const ERC20_BALANCE_ABI = [{
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
}] as const;

export default function ProfilePage() {
    const { address } = useAccount();
    const { toast } = useToast();
    const [tngnBalance, setTngnBalance] = useState<number>(0);
    const [freeBetCredits, setFreeBetCredits] = useState<number>(0);
    const [bets, setBets] = useState<UserBet[]>([]);
    const [isCustodial, setIsCustodial] = useState(true);
    const [isLoading, setIsLoading] = useState(true);

    const [depositAmount, setDepositAmount] = useState('');
    const [withdrawAmount, setWithdrawAmount] = useState('');

    useEffect(() => {
        if (!address) return;

        const fetchUserData = async () => {
            setIsLoading(true);
            const { data: user, error: userError } = await supabase
                .from('users')
                .select('tngn_balance, free_bet_credits, is_custodial, id')
                .eq('wallet_address', address)
                .single();

            if (user && !userError) {
                setTngnBalance(user.tngn_balance);
                setFreeBetCredits(user.free_bet_credits);
                setIsCustodial(user.is_custodial);

                const { data: betsData, error: betsError } = await supabase
                    .from('user_bets')
                    .select('*')
                    .eq('user_id', user.id)
                    .order('created_at', { ascending: false });

                if (betsData && !betsError) {
                    setBets(betsData);
                }
            }
            setIsLoading(false);
        };

        fetchUserData();
    }, [address]);

    // Check On-Chain Balance (for Web3 fallback users)
    const { data: onChainBalanceData } = useReadContract({
        address: TNGN_ADDRESS as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
        query: {
            enabled: !!address && !isCustodial,
        }
    });

    const displayBalance = isCustodial ? tngnBalance : Number(formatUnits(onChainBalanceData || BigInt(0), 18));

    const handleDeposit = async () => {
        const netNaira = Number(depositAmount);
        if (netNaira <= 0) return;

        // Ensure user is loaded
        const sessionStr = localStorage.getItem('truthmarket_user');
        const userSession = sessionStr ? JSON.parse(sessionStr) : null;
        if (!userSession || !userSession.id) {
            toast({ title: "Please sign in again", variant: "destructive" });
            return;
        }

        try {
            const res = await fetch('/api/transactions/deposit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userSession.id, amountNgn: netNaira })
            });

            if (!res.ok) throw new Error((await res.json()).error || 'Deposit failed');

            const data = await res.json();

            toast({
                title: "Deposit Successful",
                description: `You deposited ₦${netNaira.toLocaleString()}. Credited: ${data.tngnCredited.toLocaleString()} tNGN.`
            });

            if (isCustodial) {
                setTngnBalance(data.newBalance);
            }
            setDepositAmount('');
        } catch (error: unknown) {
            toast({ title: "Deposit Failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
        }
    };

    const handleWithdraw = async () => {
        const tngnToWithdraw = Number(withdrawAmount);
        if (tngnToWithdraw <= 0 || tngnToWithdraw > displayBalance) {
             toast({ title: "Invalid amount", variant: "destructive" });
             return;
        }

        const sessionStr = localStorage.getItem('truthmarket_user');
        const userSession = sessionStr ? JSON.parse(sessionStr) : null;
        if (!userSession || !userSession.id) {
            toast({ title: "Please sign in again", variant: "destructive" });
            return;
        }

        try {
            const res = await fetch('/api/transactions/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userSession.id, amountTngn: tngnToWithdraw })
            });

            if (!res.ok) throw new Error((await res.json()).error || 'Withdrawal failed');

            const data = await res.json();

            toast({
                title: "Withdrawal Initiated",
                description: `Withdrawing ${tngnToWithdraw.toLocaleString()} tNGN. Bank Transfer: ₦${data.netNaira.toLocaleString()}.`
            });

            if (isCustodial) {
                setTngnBalance(data.newBalance);
            }
            setWithdrawAmount('');
        } catch (error: unknown) {
            toast({ title: "Withdrawal Failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
        }
    };

    // GitHub Heatmap Logic
    const last14Days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (13 - i));
        return d.toISOString().split('T')[0];
    });

    const heatmapData = last14Days.map(dateStr => {
        const dayBets = bets.filter(b => b.created_at.startsWith(dateStr));
        if (dayBets.length === 0) return 'inactive';

        const wins = dayBets.filter(b => b.status === 'won').length;
        const losses = dayBets.filter(b => b.status === 'lost').length;

        if (wins > losses) return 'profitable';
        if (losses > wins) return 'loss';
        return 'active'; // neutral
    });

    if (!address) {
        return <div className="p-8 text-center text-muted-foreground">Please connect your account to view profile.</div>;
    }

    return (
        <div className="space-y-6 w-full max-w-2xl mx-auto pb-24">
            <h1 className="text-3xl font-bold tracking-tight">Financial Profile</h1>

            <div className="grid grid-cols-2 gap-4">
                <Card className="bg-gradient-to-br from-card to-card/50 border-muted">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <WalletIcon className="w-4 h-4" /> Total tNGN
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold">₦{displayBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </CardContent>
                </Card>

                <Card className="bg-gradient-to-br from-card to-card/50 border-muted">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Trophy className="w-4 h-4 text-yellow-500" /> Free Bet Credits
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold text-yellow-500">₦{freeBetCredits.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </CardContent>
                </Card>
            </div>

            <div className="flex gap-4">
                <Dialog>
                    <DialogTrigger asChild>
                        <Button className="flex-1 bg-green-500/10 text-green-500 hover:bg-green-500/20 border-green-500/20" variant="outline">
                            <ArrowDownCircle className="w-4 h-4 mr-2" /> Deposit Naira
                        </Button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Deposit via Paystack</DialogTitle>
                            <DialogDescription>Funds are converted to tNGN with a 1.5% spread.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 pt-4">
                            <Input
                                type="number"
                                placeholder="Amount in NGN"
                                value={depositAmount}
                                onChange={(e) => setDepositAmount(e.target.value)}
                            />
                            <Button onClick={handleDeposit} className="w-full">Confirm Deposit</Button>
                        </div>
                    </DialogContent>
                </Dialog>

                <Dialog>
                    <DialogTrigger asChild>
                        <Button className="flex-1 bg-red-500/10 text-red-500 hover:bg-red-500/20 border-red-500/20" variant="outline">
                            <ArrowUpCircle className="w-4 h-4 mr-2" /> Withdraw
                        </Button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Withdraw to Bank</DialogTitle>
                            <DialogDescription>A 1.5% spread and ₦100 flat fee applies.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 pt-4">
                            <Input
                                type="number"
                                placeholder="Amount in tNGN"
                                value={withdrawAmount}
                                onChange={(e) => setWithdrawAmount(e.target.value)}
                                max={displayBalance}
                            />
                            <div className="text-xs text-muted-foreground text-right">Max: {displayBalance.toLocaleString()}</div>
                            <Button onClick={handleWithdraw} className="w-full">Confirm Withdrawal</Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <Card className="border-muted bg-card/50">
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <History className="w-5 h-5" /> Activity Heatmap (14 Days)
                    </CardTitle>
                    <CardDescription>Your betting performance over the last two weeks.</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex gap-2 justify-center">
                        {heatmapData.map((status, idx) => {
                            let bg = 'bg-muted/30';
                            if (status === 'profitable') bg = 'bg-green-500';
                            if (status === 'loss') bg = 'bg-red-500';
                            if (status === 'active') bg = 'bg-blue-500/50';

                            return (
                                <div
                                    key={idx}
                                    className={`w-8 h-8 rounded-sm ${bg} transition-all hover:ring-2 ring-foreground/20`}
                                    title={`${last14Days[idx]}: ${status}`}
                                />
                            );
                        })}
                    </div>
                </CardContent>
            </Card>

            <div className="space-y-4">
                <h3 className="text-lg font-medium tracking-tight">Recent Receipts</h3>
                <div className="space-y-3">
                    {bets.slice(0, 5).map(bet => (
                        <Card key={bet.id} className="bg-card hover:bg-muted/10 transition-colors">
                            <CardContent className="p-4 flex justify-between items-center">
                                <div>
                                    <div className="font-medium text-sm">{bet.market_title || 'Unknown Market'}</div>
                                    <div className="text-xs text-muted-foreground mt-1 flex gap-2">
                                        <span>Prediction: <strong className="text-foreground">{bet.outcome}</strong></span>
                                        <span>•</span>
                                        <span>Stake: ₦{bet.staked_amount.toLocaleString()}</span>
                                    </div>
                                </div>

                                {bet.status === 'won' && (
                                    <Button size="icon" variant="ghost" className="text-green-500 hover:text-green-400 hover:bg-green-500/10" title="Share Receipt">
                                        <Share2 className="w-4 h-4" />
                                    </Button>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                    {bets.length === 0 && !isLoading && (
                        <div className="text-center text-sm text-muted-foreground p-4">No recent activity.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
