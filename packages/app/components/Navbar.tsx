'use client';

import { useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { MOCK_USDC_ADDRESS, MOCK_USDC_ABI } from '@/lib/constants';

export function Navbar() {
  const chainId = useChainId();
  const { address } = useAccount();
  const { toast } = useToast();

  const { data: hash, writeContract, isPending } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  useEffect(() => {
    if (isSuccess) {
      toast({
        title: "Success",
        description: "Minted 1,000 USDC",
      });
    }
  }, [isSuccess, toast]);

  const handleMint = () => {
    if (!address) return;
    writeContract({
      address: MOCK_USDC_ADDRESS as `0x${string}`,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [address, parseUnits('1000', 18)],
    });
  };

  // Polygon Amoy is 80002
  const showFaucet = chainId === 80002;

  return (
    <nav className="flex items-center justify-between p-4 border-b">
      <div className="text-xl font-bold">
        <span>TruthMarket</span>
      </div>
      <div className="flex items-center gap-4">
        {showFaucet && (
          <Button
            variant="outline"
            onClick={handleMint}
            disabled={isPending || isConfirming}
          >
            {isPending || isConfirming ? 'Minting...' : 'Get Test USDC'}
          </Button>
        )}
        <ConnectButton />
      </div>
    </nav>
  );
}
