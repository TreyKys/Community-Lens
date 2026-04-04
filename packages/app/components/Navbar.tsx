'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { AuthModal } from '@/components/AuthModal';
import { NotificationBell } from '@/components/NotificationBell';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export function Navbar() {
  const [session, setSession] = useState<any>(null);
  const [bonusBalance, setBonusBalance] = useState<number>(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;
    supabase
      .from('users')
      .select('bonus_balance')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => { if (data?.bonus_balance) setBonusBalance(data.bonus_balance); });
  }, [session]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  return (
    <nav className="flex items-center justify-between p-4 border-b bg-background/95 backdrop-blur-sm sticky top-0 z-40">
      <Link href="/" className="text-xl font-bold flex items-center gap-3 hover:opacity-80 transition-opacity">
        <div className="flex items-center justify-center w-9 h-9 bg-gradient-to-br from-white to-zinc-500 text-black font-extrabold rounded-md shadow-lg shadow-white/10 tracking-tighter text-sm">
          T/M
        </div>
        <span className="hidden md:inline tracking-tight">TruthMarket</span>
      </Link>

      <div className="flex items-center gap-2">
        {session && bonusBalance > 0 && (
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-full text-amber-500 text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            {bonusBalance.toLocaleString()} Bonus tNGN
          </div>
        )}

        {session && <NotificationBell />}
        {session && <WalletModal />}

        {session ? (
          <Button onClick={handleSignOut} variant="outline" size="sm">
            Sign Out
          </Button>
        ) : (
          <AuthModal />
        )}
      </div>
    </nav>
  );
}
