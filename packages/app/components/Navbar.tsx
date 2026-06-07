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
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [bonusBalance, setBonusBalance] = useState<number>(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;

    const fetchBalances = async () => {
      const { data } = await supabase
        .from('users')
        .select('tngn_balance, bonus_balance')
        .eq('id', session.user.id)
        .single();
      if (data) {
        setCashBalance(data.tngn_balance || 0);
        setBonusBalance(data.bonus_balance || 0);
      }
    };

    fetchBalances();

    // Realtime updates so balances reflect bets, payouts and credits within ~100ms
    // anywhere in the app, without polling.
    const channel = supabase
      .channel(`users:${session.user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'users',
        filter: `id=eq.${session.user.id}`,
      }, () => fetchBalances())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  // Signed-in users have no business on the marketing page — bounce them to /markets.
  const logoHref = session ? '/markets' : '/';

  return (
    <nav className="flex items-center justify-between p-4 border-b border-emerald-500/10 bg-background/95 backdrop-blur-sm sticky top-0 z-40">
      <Link href={logoHref} className="text-xl font-bold flex items-center gap-3 hover:opacity-80 transition-opacity">
        <div className="flex items-center justify-center w-9 h-9 bg-gradient-to-br from-emerald-400 to-emerald-600 text-black font-extrabold rounded-md shadow-lg shadow-emerald-500/30 tracking-tighter text-[11px]">
          O/N
        </div>
        <span className="hidden md:inline tracking-tight">Opinions.ng</span>
      </Link>

      <div className="flex items-center gap-2">
        {session && (cashBalance > 0 || bonusBalance > 0) && (
          <Link
            href="/dashboard"
            className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-emerald-500/10 to-emerald-600/10 border border-emerald-500/25 rounded-full text-emerald-300 text-sm font-medium hover:border-emerald-500/50 transition-colors"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            ₦<AnimatedNumber value={cashBalance + bonusBalance} />
          </Link>
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
