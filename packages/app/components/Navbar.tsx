'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId } from 'wagmi';
import { WalletModal } from '@/components/WalletModal';

export function Navbar() {
  const chainId = useChainId();
  const { address } = useAccount();

  // Polygon Amoy is 80002
  const showWallet = chainId === 80002 && !!address;

  return (
    <nav className="flex items-center justify-between p-4 border-b">
      <div className="text-xl font-bold">
        <span>TruthMarket</span>
      </div>
      <div className="flex items-center gap-4">
        {showWallet && <WalletModal />}
        <ConnectButton />
      </div>
    </nav>
  );
}
