'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Home, Compass, Receipt, User, Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Sidebar } from '@/components/Sidebar';
import { AuthModal } from '@/components/AuthModal';

export function BottomTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-background/95 backdrop-blur-sm border-t flex items-center justify-around px-2 z-50 pb-safe">
      <Sheet>
        <SheetTrigger asChild>
          <button className="flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors">
            <Menu className="w-5 h-5" />
            <span className="text-[10px] font-medium">Menu</span>
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-64 bg-background border-r">
          <div className="p-4 border-b flex items-center gap-4">
            <div className="flex items-center justify-center w-10 h-10 bg-gradient-to-br from-white to-zinc-500 text-black font-extrabold rounded-md shadow-lg shadow-white/10 tracking-tighter">T/M</div>
            <span className="font-bold">TruthMarket</span>
          </div>
          <Sidebar />
        </SheetContent>
      </Sheet>

      <button
        onClick={() => router.push('/')}
        className={cn('flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors', pathname === '/' ? 'text-foreground' : 'text-muted-foreground')}
      >
        <Home className="w-5 h-5" />
        <span className="text-[10px] font-medium">Home</span>
      </button>

      <button
        onClick={() => router.push('/markets')}
        className={cn('flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors', pathname.startsWith('/markets') ? 'text-foreground' : 'text-muted-foreground')}
      >
        <Compass className="w-5 h-5" />
        <span className="text-[10px] font-medium">Explore</span>
      </button>

      {session ? (
        <button
          onClick={() => router.push('/bets')}
          className={cn('flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors relative', pathname.startsWith('/bets') ? 'text-foreground' : 'text-muted-foreground')}
        >
          <Receipt className="w-5 h-5" />
          <span className="text-[10px] font-medium">Bets</span>
        </button>
      ) : (
        <button className="flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground">
          <Receipt className="w-5 h-5 opacity-40" />
          <span className="text-[10px] font-medium opacity-40">Bets</span>
        </button>
      )}

      {session ? (
        <button
          onClick={() => router.push('/profile')}
          className={cn('flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors', pathname.startsWith('/profile') ? 'text-foreground' : 'text-muted-foreground')}
        >
          <User className="w-5 h-5" />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      ) : (
        <div className="flex flex-col items-center justify-center w-16 h-full gap-1">
          <AuthModal variant="icon" />
        </div>
      )}
    </div>
  );
}
