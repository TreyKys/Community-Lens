'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { TNGN_ADDRESS, TNGN_ABI } from '@/lib/constants';
import { Wallet } from 'lucide-react';

export function WalletModal() {
  const { address, isConnected } = useAccount();
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);

  // Faucet Logic
  const { data: hash, writeContract, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) {
      toast({
        title: "Success",
        description: "Minted 1,000 tNGN (Demo)",
      });
      setIsOpen(false);
    }
  }, [isSuccess, toast]);

  useEffect(() => {
    if (error) {
        toast({
            title: "Mint Failed",
            description: error.message || "Something went wrong.",
            variant: "destructive"
        });
    }
  }, [error, toast]);

  const handleMint = () => {
    if (!address || !isConnected) {
        toast({ title: "Wallet not connected", description: "Please connect your wallet first." });
        return;
    }

    writeContract({
      address: TNGN_ADDRESS as `0x${string}`,
      abi: TNGN_ABI,
      functionName: 'mint',
      args: [address, parseUnits('1000', 18)],
    });
  };

  // Paystack Logic
  const [amount, setAmount] = useState('');
  const handleDeposit = () => {
    if (!amount || isNaN(Number(amount))) {
        toast({ title: "Invalid Amount", description: "Please enter a valid amount.", variant: "destructive" });
        return;
    }

    // UI Illusion for bonus
    const deposited = Number(amount);
    const actual = deposited * 0.99;
    const bonus = deposited * 0.01;

    toast({
        title: "Deposit Successful!",
        description: `₦${actual.toLocaleString()} added + ₦${bonus.toLocaleString()} Betting Bonus!`,
        variant: "default",
    });
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 bg-muted/50 border-muted hover:bg-muted">
          <Wallet className="h-4 w-4" />
          Deposit Naira
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] border-muted">
        <DialogHeader>
          <DialogTitle>Cashier</DialogTitle>
          <DialogDescription>
            Manage your funds. Add money to start predicting.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="real" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="real">Real Money</TabsTrigger>
            <TabsTrigger value="demo">Demo Mode</TabsTrigger>
          </TabsList>

          <TabsContent value="real" className="space-y-4 py-4">
            <div className="text-sm text-muted-foreground">
              Deposit Naira securely via Paystack. You will receive a 1% Betting Bonus on all deposits!
            </div>
            <div className="space-y-2 relative">
                <Input
                    type="number"
                    placeholder="Amount (₦)"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pl-8"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
            </div>
            <Button onClick={handleDeposit} className="w-full bg-foreground text-background hover:bg-foreground/90 font-semibold">
                Deposit Naira
            </Button>
          </TabsContent>

          <TabsContent value="demo" className="space-y-4 py-4">
            <div className="text-sm text-muted-foreground">
              Get free tokens to test out the platform before using real money.
            </div>
            <Button
                onClick={handleMint}
                disabled={isPending || isConfirming}
                className="w-full"
                variant="secondary"
            >
                {isPending || isConfirming ? 'Adding...' : 'Get ₦1,000 Demo Funds'}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
