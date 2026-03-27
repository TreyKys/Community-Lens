'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useAccount, useChainId } from 'wagmi';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function Navbar() {
  const { login, authenticated, logout } = usePrivy();
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const [bonusBalance, setBonusBalance] = useState<number>(0);

  // Polygon Amoy is 80002
  const showWallet = chainId === 80002 && !!address;

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

    if (isConnected || authenticated) {
        fetchBonusBalance();
    }
  }, [address, isConnected, authenticated]);

  return (
    <nav className="flex items-center justify-between p-4 border-b">
      <div className="text-xl font-bold flex items-center gap-4">
        <div className="hidden md:flex items-center justify-center w-10 h-10 bg-gradient-to-br from-white to-zinc-500 text-black font-extrabold rounded-md shadow-lg shadow-white/10 tracking-tighter">
          T/M
        </div>
        <span className="hidden md:inline">TruthMarket</span>
        <div className="md:hidden flex items-center justify-center w-10 h-10 bg-gradient-to-br from-white to-zinc-500 text-black font-extrabold rounded-md shadow-lg shadow-white/10 tracking-tighter">
          T/M
        </div>
      </div>
      <div className="flex items-center gap-4">
        {(isConnected || authenticated) && bonusBalance > 0 && (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-full text-amber-500 text-sm font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                {bonusBalance.toLocaleString()} Bonus tNGN
            </div>
        )}

        {showWallet && <WalletModal />}

        {authenticated || isConnected ? (
            <Button onClick={logout} variant="outline">
              Sign Out
            </Button>
        ) : (
            <div className="flex items-center gap-2">
              <Button size="lg" className="font-semibold px-6" onClick={login}>
                Sign In / Sign Up
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="rounded-full w-8 h-8 text-muted-foreground hover:text-primary">
                      <Info className="h-4 w-4" />
                      <span className="sr-only">Wallet Info</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[250px] p-4 text-sm leading-relaxed">
                    <p className="font-semibold mb-1">What is a Web3 Wallet?</p>
                    A digital wallet (like MetaMask or Coinbase Wallet) lets you log in without passwords and take full custody of your funds. You approve transactions cryptographically.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
        )}
      </div>
    </nav>
  );
}
