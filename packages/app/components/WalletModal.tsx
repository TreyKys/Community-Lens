'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { MOCK_USDC_ADDRESS, MOCK_USDC_ABI } from '@/lib/constants';
import { Wallet } from 'lucide-react';

// Aggressive Gas Configuration for Amoy
const GAS_OVERRIDES = {
    maxFeePerGas: parseUnits('100', 9), // 100 Gwei
    maxPriorityFeePerGas: parseUnits('50', 9), // 50 Gwei
};

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
        description: "Minted 1,000 USDC (Demo)",
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
      address: MOCK_USDC_ADDRESS as `0x${string}`,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [address, parseUnits('1000', 18)],
      ...GAS_OVERRIDES,
    });
  };

  // Paystack Logic
  const [amount, setAmount] = useState('');
  const handleDeposit = () => {
    if (!amount || isNaN(Number(amount))) {
        toast({ title: "Invalid Amount", description: "Please enter a valid amount.", variant: "destructive" });
        return;
    }
    toast({
        title: "Redirecting to Paystack...",
        description: `Deposit of ${amount} NGN initiated. (Coming in Mainnet Launch)`,
    });
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Wallet className="h-4 w-4" />
          Wallet
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Wallet & Cashier</DialogTitle>
          <DialogDescription>
            Manage your funds. Switch between Demo Mode and Real Money.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="demo" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="demo">Demo Mode</TabsTrigger>
            <TabsTrigger value="real">Real Money</TabsTrigger>
          </TabsList>

          <TabsContent value="demo" className="space-y-4 py-4">
            <div className="text-sm text-muted-foreground">
              Get free MockUSDC to test the platform on Polygon Amoy.
            </div>
            <Button
                onClick={handleMint}
                disabled={isPending || isConfirming}
                className="w-full"
            >
                {isPending || isConfirming ? 'Minting...' : 'Get 1,000 Demo USDC'}
            </Button>
          </TabsContent>

          <TabsContent value="real" className="space-y-4 py-4">
            <div className="text-sm text-muted-foreground">
              Deposit Nigerian Naira (NGN) via Paystack to receive USDC.
            </div>
            <div className="space-y-2">
                <Input
                    type="number"
                    placeholder="Amount (NGN)"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                />
            </div>
            <Button onClick={handleDeposit} className="w-full">
                Deposit with Paystack
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
