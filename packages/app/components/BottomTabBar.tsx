'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Home, Compass, Receipt, User, Menu, LayoutDashboard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Sidebar } from '@/components/Sidebar';
import { AuthModal } from '@/components/AuthModal';

// Floating dock, replacing the edge-welded bar.
//
// WHY NOT A SIDE RAIL. Moving navigation to the left or right edge was the
// other option considered. It loses on two counts that are not close:
// roughly half of mobile users drive one-handed with a thumb, and the bottom
// strip is the only region every thumb reaches comfortably — a rail is
// hardest exactly where the primary controls would be. And the cost is paid
// in the scarcer dimension: ~60px of a 390px-wide screen is 15% of the width
// gone from every card and price on every screen, versus ~7% of height for a
// bar. A left rail also fights the iOS back-swipe and Android edge gestures.
//
// So the placement stays and the TREATMENT changes: detached from the edge,
// rounded, glass, with an emerald glow under the active tab. Same reach,
// different object.
//
// AUTO-HIDE is what actually buys back the space. It slides away as you read
// down a list of markets and returns the moment you scroll up — the standard
// content-first pattern (Instagram, X), and the honest answer to "use the
// bottom space for something else": the best use of it is usually nothing,
// until the user asks for navigation back.
//
// Thresholds are deliberate rather than tuned by feel: hide after ~180px of
// downward travel so a small jitter never hides it, show again after ~50px
// up so the gesture feels instant. Never hidden near the top of the page,
// where there is nothing to gain and a missing bar just looks broken.

const HIDE_AFTER_PX = 180;
const SHOW_AFTER_PX = 50;
const ALWAYS_SHOW_ABOVE_PX = 120;

export function BottomTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<any>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Scroll direction, read passively and coalesced into one rAF write per
  // frame. Anchor tracking (rather than comparing to the last scrollY) is what
  // makes the thresholds mean "travelled this far in one direction" instead of
  // "moved a pixel", which is the difference between a bar that hides
  // decisively and one that flickers.
  const lastY = useRef(0);
  const anchor = useRef(0);
  const dir = useRef<'up' | 'down'>('up');
  const frame = useRef(0);

  useEffect(() => {
    // A user who has asked for less motion should not have the chrome moving
    // under them; pin it visible and skip the listener entirely.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    lastY.current = window.scrollY;
    anchor.current = window.scrollY;

    const apply = () => {
      frame.current = 0;
      const y = window.scrollY;
      const goingDown = y > lastY.current;

      if (goingDown !== (dir.current === 'down')) {
        dir.current = goingDown ? 'down' : 'up';
        anchor.current = y;               // direction changed — measure from here
      }
      lastY.current = y;

      if (y < ALWAYS_SHOW_ABOVE_PX) { setHidden(false); return; }
      if (goingDown && y - anchor.current > HIDE_AFTER_PX) setHidden(true);
      else if (!goingDown && anchor.current - y > SHOW_AFTER_PX) setHidden(false);
    };

    const onScroll = () => { if (!frame.current) frame.current = requestAnimationFrame(apply); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  const go = (href: string) => router.push(href);

  return (
    <div
      className={cn(
        'md:hidden fixed inset-x-3 bottom-3 z-50 transition-transform duration-300 ease-out',
        // Translates past its own height plus the safe-area inset, so on a
        // notched phone it clears the home indicator instead of peeking.
        hidden && 'translate-y-[calc(100%+1.5rem)]',
      )}
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div
        className={cn(
          'flex items-center justify-around gap-1 rounded-2xl px-1.5 py-1.5',
          'bg-popover/80 backdrop-blur-xl',
          'border border-emerald-500/15',
          // Two shadows doing different jobs: a hard black one to lift the
          // dock off the content behind it, and a wide emerald one so it reads
          // as part of the brand rather than a floating grey box.
          'shadow-[0_8px_32px_-8px_rgba(0,0,0,0.8),0_0_24px_-6px_rgba(27,202,121,0.25)]',
        )}
      >
        <Sheet>
          <SheetTrigger asChild>
            <DockButton icon={Menu} label="Menu" active={false} />
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-64 bg-background border-r">
            <div className="p-4 border-b flex items-center gap-4">
              <div className="flex items-center justify-center w-10 h-10 bg-gradient-to-br from-emerald-400 to-emerald-600 text-black font-extrabold rounded-md shadow-lg shadow-emerald-500/20 tracking-tighter text-xs">O/N</div>
              <span className="font-bold">Opinions.ng</span>
            </div>
            <Sidebar />
          </SheetContent>
        </Sheet>

        {session ? (
          <DockButton icon={LayoutDashboard} label="Wallet"
                      active={pathname === '/dashboard'} onClick={() => go('/dashboard')} />
        ) : (
          <DockButton icon={Home} label="Home"
                      active={pathname === '/'} onClick={() => go('/')} />
        )}

        <DockButton icon={Compass} label="Explore"
                    active={pathname.startsWith('/markets')} onClick={() => go('/markets')} />

        {session ? (
          <DockButton icon={Receipt} label="Picks"
                      active={pathname.startsWith('/bets')} onClick={() => go('/bets')} />
        ) : (
          <DockButton icon={Receipt} label="Picks" active={false} disabled />
        )}

        {session ? (
          <DockButton icon={User} label="Profile"
                      active={pathname.startsWith('/profile')} onClick={() => go('/profile')} />
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 min-w-0 h-12 gap-0.5">
            <AuthModal variant="icon" />
          </div>
        )}
      </div>
    </div>
  );
}

const DockButton = ({ icon: Icon, label, active, onClick, disabled }: {
  icon: typeof Home; label: string; active: boolean;
  onClick?: () => void; disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-current={active ? 'page' : undefined}
    className={cn(
      // h-12 keeps every target at 48px, the floor below which taps start
      // landing on the wrong item. flex-1 shares the width evenly so the dock
      // stays balanced whether the user is signed in or not.
      'relative flex flex-col items-center justify-center flex-1 min-w-0 h-12 gap-0.5 rounded-xl',
      'transition-colors duration-150',
      active ? 'text-emerald-300 bg-emerald-500/10' : 'text-muted-foreground',
      disabled && 'opacity-40',
    )}
  >
    {/* The active marker is a glow behind the icon rather than a line under
        the label: on a rounded floating dock an underline has no edge to sit
        against and reads as a stray mark. */}
    {active && (
      <span aria-hidden
            className="absolute inset-x-3 top-1 h-6 rounded-full bg-emerald-500/20 blur-md" />
    )}
    <Icon className="relative w-5 h-5" />
    <span className="relative text-[10px] font-medium leading-none">{label}</span>
  </button>
);
