'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId } from 'wagmi';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function Navbar() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();

  // Custom Supabase OTP Auth state
  const [isSupabaseAuthOpen, setIsSupabaseAuthOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [authenticated, setAuthenticated] = useState(false);

  const [bonusBalance, setBonusBalance] = useState<number>(0);

  // Polygon Amoy is 80002
  const showWallet = chainId === 80002 && !!address;

  useEffect(() => {
    async function fetchBonusBalance() {
      if (!address && !authenticated) return;

      // In a real scenario, this gets the current user's session from Supabase
      // For this migration demo, we'll map connected Web3 addresses
      const queryAddr = address ? address.toLowerCase() : 'dummy_custodial';

      try {
        const { data } = await supabase
            .from('users')
            .select('free_bet_credits')
            .eq('wallet_address', queryAddr)
            .single();

        if (data && data.free_bet_credits) {
            setBonusBalance(data.free_bet_credits);
        }
      } catch (err) {
        console.error("Failed to fetch free bet balance:", err);
      }
    }

    if (isConnected || authenticated) {
        fetchBonusBalance();
    }
  }, [address, isConnected, authenticated]);

  const [isLoading, setIsLoading] = useState(false);

  const handleSupabaseLogin = async () => {
      if (!email && !phone) return;

      setIsLoading(true);
      try {
          const res = await fetch('/api/auth/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email || null, phone: phone || null })
          });

          if (!res.ok) throw new Error('Auth failed');

          const data = await res.json();
          if (data.success && data.user) {
              // Store session (simplified for demo)
              localStorage.setItem('truthmarket_user', JSON.stringify(data.user));
              setAuthenticated(true);
              setIsSupabaseAuthOpen(false);

              // Simulate page reload or state update for balance refetching
              window.location.reload();
          }
      } catch (error: unknown) {
          console.error("Login Error:", error);
      } finally {
          setIsLoading(false);
      }
  };

  useEffect(() => {
      // Restore session on mount
      const sessionStr = localStorage.getItem('truthmarket_user');
      if (sessionStr) {
          try {
              const user = JSON.parse(sessionStr);
              if (user && user.id) {
                  setAuthenticated(true);
              }
          } catch (e: unknown) {
              console.error(e);
          }
      }
  }, []);

  const handleLogout = () => {
      localStorage.removeItem('truthmarket_user');
      setAuthenticated(false);
      window.location.reload();
  };

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

        {authenticated ? (
            <Button onClick={handleLogout} variant="outline">
              Sign Out
            </Button>
        ) : isConnected ? (
             <ConnectButton showBalance={false} />
        ) : (
            <div className="flex items-center gap-2">
              <Dialog open={isSupabaseAuthOpen} onOpenChange={setIsSupabaseAuthOpen}>
                  <DialogTrigger asChild>
                      <Button size="lg" className="font-semibold px-6">
                        Sign In / Sign Up
                      </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                      <DialogHeader>
                          <DialogTitle>Welcome to TruthMarket</DialogTitle>
                      </DialogHeader>
                      <div className="flex flex-col gap-4 py-4">
                          <Input placeholder="Email Address" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setPhone(''); }} />
                          <div className="text-center text-sm text-muted-foreground">OR</div>
                          <Input placeholder="Phone Number" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setEmail(''); }} />
                          <Button onClick={() => void handleSupabaseLogin()} disabled={isLoading || (!email && !phone)} className="w-full">
                                {isLoading ? "Verifying..." : "Send OTP"}
                          </Button>

                          <div className="mt-6 text-center">
                              <span className="text-xs text-muted-foreground">Are you a crypto native? </span>
                              <div className="mt-2 scale-90 flex justify-center">
                                  <ConnectButton label="Connect Web3 Wallet" />
                              </div>
                          </div>
                      </div>
                  </DialogContent>
              </Dialog>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="rounded-full w-8 h-8 text-muted-foreground hover:text-primary">
                      <Info className="h-4 w-4" />
                      <span className="sr-only">Wallet Info</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[250px] p-4 text-sm leading-relaxed">
                    <p className="font-semibold mb-1">Standard OTP vs Web3</p>
                    Most users log in with their Phone/Email. If you are familiar with crypto, click &apos;Connect Web3 Wallet&apos; to self-custody your funds.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
        )}
      </div>
    </nav>
  );
}
