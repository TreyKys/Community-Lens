'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { AuthModal } from '@/components/AuthModal';
import { Button } from '@/components/ui/button';

export function Navbar() {
  const [session, setSession] = useState<any>(null);
  const [bonusBalance, setBonusBalance] = useState<number>(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;

    const fetchBonusBalance = async () => {
      const { data } = await supabase
        .from('users')
        // Column is now bonus_balance (not walletAddress-based lookup)
        .select('bonus_balance')
        .eq('id', session.user.id)
        .single();

      if (data?.bonus_balance) setBonusBalance(data.bonus_balance);
    };

    fetchBonusBalance();
  }, [session]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  return (
    <nav className="flex items-center justify-between p-4 border-b">
      <div className="text-xl font-bold flex items-center gap-4">
        <div className="flex items-center justify-center w-10 h-10 bg-gradient-to-br from-white to-zinc-500 text-black font-extrabold rounded-md shadow-lg shadow-white/10 tracking-tighter">
          T/M
        </div>
        <span className="hidden md:inline">TruthMarket</span>
      </div>

      <div className="flex items-center gap-4">
        {/* Bonus balance badge — only shown when user has a bonus credit */}
        {session && bonusBalance > 0 && (
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-full text-amber-500 text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            {bonusBalance.toLocaleString()} Bonus tNGN
          </div>
        )}

        {/* Cashier button — only shown when logged in */}
        {session && <WalletModal />}

        {session ? (
          <Button onClick={handleSignOut} variant="outline">
            Sign Out
          </Button>
        ) : (
          <AuthModal />
        )}
      </div>
    </nav>
  );
}
