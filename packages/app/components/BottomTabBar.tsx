'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Home, Compass, PieChart, User, Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Sidebar } from '@/components/Sidebar';
import { AuthModal } from '@/components/AuthModal';
import { Dialog, DialogTrigger, DialogContent } from '@/components/ui/dialog';

export function BottomTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleProfileClick = () => {
    if (session) {
      router.push('/profile');
    }
  };

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-background border-t flex items-center justify-around px-2 z-50 pb-safe">
      <Sheet>
        <SheetTrigger asChild>
          <button className="flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors">
            <Menu className="w-5 h-5" />
            <span className="text-[10px] font-medium">Menu</span>
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-64 bg-background border-r">
            <div className="p-4 border-b flex items-center gap-4">
              <div className="flex items-center justify-center w-10 h-10 bg-gradient-to-br from-white to-zinc-500 text-black font-extrabold rounded-md shadow-lg shadow-white/10 tracking-tighter">
                T/M
              </div>
              <span className="font-bold">TruthMarket</span>
            </div>
            <Sidebar />
        </SheetContent>
      </Sheet>

      <button
        onClick={() => router.push('/')}
        className={cn("flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors", pathname === '/' && "text-foreground")}
      >
        <Home className="w-5 h-5" />
        <span className="text-[10px] font-medium">Home</span>
      </button>

      <button
        onClick={() => router.push('/markets')}
        className={cn("flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors", pathname.startsWith('/markets') && "text-foreground")}
      >
        <Compass className="w-5 h-5" />
        <span className="text-[10px] font-medium">Explore</span>
      </button>

      <button
        onClick={() => router.push('/portfolio')}
        className={cn("flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors", pathname.startsWith('/portfolio') && "text-foreground")}
      >
        <PieChart className="w-5 h-5" />
        <span className="text-[10px] font-medium">Open Bets</span>
      </button>

      {session ? (
        <button
          onClick={handleProfileClick}
          className={cn("flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors", pathname.startsWith('/profile') && "text-foreground")}
        >
          <User className="w-5 h-5" />
          <span className="text-[10px] font-medium">Profile</span>
        </button>
      ) : (
        <div className="flex flex-col items-center justify-center w-16 h-full gap-1 text-muted-foreground transition-colors">
          <AuthModal />
        </div>
      )}
    </div>
  );
}
