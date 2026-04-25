'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { AuthModal } from '@/components/AuthModal';
import { NotificationBell } from '@/components/NotificationBell';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
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

    const fetchBonus = async () => {
      const { data } = await supabase
        .from('users')
        .select('bonus_balance')
        .eq('id', session.user.id)
        .single();
      if (data?.bonus_balance !== undefined) setBonusBalance(data.bonus_balance || 0);
    };

    fetchBonus();

    const channel = supabase
      .channel(`users:${session.user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'users',
        filter: `id=eq.${session.user.id}`,
      }, () => fetchBonus())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  return (
    <nav className="flex items-center justify-between p-4 border-b bg-background/95 backdrop-blur-sm sticky top-0 z-40">
      <Link href="/" className="text-xl font-bold flex items-center gap-3 hover:opacity-80 transition-opacity">
        <div className="flex items-center justify-center w-9 h-9 bg-gradient-to-br from-emerald-400 to-emerald-600 text-black font-extrabold rounded-md shadow-lg shadow-emerald-500/20 tracking-tighter text-[11px]">
          O/N
        </div>
        <span className="hidden md:inline tracking-tight">Odds.ng</span>
      </Link>

      <div className="flex items-center gap-2">
        {session && bonusBalance > 0 && (
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-full text-amber-500 text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            <AnimatedNumber value={bonusBalance} /> Bonus tNGN
          </div>
        )}

        <ThemeToggle />

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
