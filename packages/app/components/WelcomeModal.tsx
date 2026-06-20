'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Sparkles, Zap, Trophy, ArrowRight } from 'lucide-react';

// First-visit conversion modal. Shows once to unauthenticated visitors,
// pitches the deposit bonus + value prop, and routes them into the
// signup flow via a window event that opens AuthModal.
//
// We don't re-show within a 14-day window once dismissed — the X ads
// campaign brings traffic over 5 days, so a single dismissal should
// cover the whole window without nagging the same visitor twice.

const STORAGE_KEY = 'opinionsng_welcome_dismissed_at';
const REPROMPT_DAYS = 14;
// Short enough that we don't lose bouncing ad traffic, long enough that
// the page paints first so the modal feels intentional rather than a
// blocker on a still-loading site.
const SHOW_AFTER_MS = 1200;

const AUTH_OPEN_EVENT = 'opinionsng:open-auth';

function shouldSkipRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  // Admin doesn't need the consumer pitch.
  if (pathname.startsWith('/admin')) return true;
  return false;
}

export function WelcomeModal() {
  const [isOpen, setIsOpen] = useState(false);
  // null = unknown (initial async check); false = signed out; true = signed in.
  // Render path gates on this so we never show the modal to a signed-in
  // user — including the edge case where they sign in *while* the modal
  // is mounted (e.g. via another tab, the post-OTP redirect, or the
  // AuthModal completing mid-stream).
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const pathname = usePathname();

  // Single source of truth for "is this visitor signed in" — gets set
  // once on mount + updated on every auth state change so the modal
  // self-closes the moment the user signs in.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (mounted) setHasSession(!!session?.user);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if (mounted) setHasSession(!!s?.user);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (shouldSkipRoute(pathname)) return;
    // Don't queue the timer until we know whether the user is signed in.
    // Skip queueing entirely once we know they are.
    if (hasSession === null || hasSession === true) return;

    // Honor opt-out via ?noWelcome=1 (handy for QA + screenshots).
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('noWelcome') === '1') return;
    } catch {}

    // 14-day cool-down so repeat visitors aren't nagged.
    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (dismissed) {
        const t = parseInt(dismissed, 10);
        if (Number.isFinite(t)) {
          const daysSince = (Date.now() - t) / (1000 * 60 * 60 * 24);
          if (daysSince < REPROMPT_DAYS) return;
        }
      }
    } catch {}

    const timer = setTimeout(() => setIsOpen(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pathname, hasSession]);

  // Auto-close if the user signs in while the modal is showing.
  useEffect(() => {
    if (hasSession === true && isOpen) setIsOpen(false);
  }, [hasSession, isOpen]);

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {}
    setIsOpen(false);
  };

  const openAuth = () => {
    // Close ourselves first so radix can release the focus trap, then
    // dispatch on the next tick. Opening AuthModal while this Dialog
    // is still mounted can fight for focus and leave the page with a
    // ghost backdrop.
    setIsOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {}
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(AUTH_OPEN_EVENT));
    }, 180);
  };

  // Never render for signed-in users — saves a wasted dialog tree in the
  // portal and prevents any race where state lags the session.
  if (hasSession === true) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent
        className="sm:max-w-[520px] p-0 max-h-[90vh] overflow-y-auto bg-gradient-to-b from-emerald-950/40 via-background to-background border border-emerald-500/30 shadow-2xl shadow-emerald-500/10"
      >
        {/* Animated ambient glow — purely decorative, gives the modal a
            "live" feel without depending on any data fetch. */}
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[420px] h-[420px] bg-emerald-500/15 rounded-full blur-3xl pointer-events-none animate-pulse" />

        <div className="relative">
          {/* Hero */}
          <div className="px-6 pt-7 pb-3 text-center">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/40 mb-3 relative">
              <span className="absolute inset-0 rounded-full bg-emerald-400/20 animate-ping" />
              <Sparkles className="w-3.5 h-3.5 text-emerald-300 relative" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-300 relative">
                Welcome to Opinions.ng
              </span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black tracking-tight leading-tight">
              Got an opinion?<br />
              <span className="bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-500 bg-clip-text text-transparent">
                Get rewarded for it.
              </span>
            </h2>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto leading-relaxed">
              Nigeria&rsquo;s first prediction market. Real money, real markets, real conviction.
            </p>
          </div>

          {/* Benefit cards */}
          <div className="px-6 py-4 space-y-2.5">
            <BenefitRow
              icon={<Zap className="w-4 h-4 text-emerald-300" />}
              title="100% match on your first deposit"
              description="We double your starting balance — up to ₦5,000 in bonus credit."
            />
            <BenefitRow
              icon={<Trophy className="w-4 h-4 text-emerald-300" />}
              title="Predict anything"
              description="Football, politics, crypto, pop culture. If it has an outcome, there&rsquo;s a market."
            />
            <BenefitRow
              icon={<Sparkles className="w-4 h-4 text-emerald-300" />}
              title="Instant Naira settlement"
              description="Winners paid out the moment a market resolves. No waiting, no withdrawal hoops."
            />
          </div>

          {/* CTAs */}
          <div className="px-6 pb-5 pt-1 space-y-2">
            <Button
              onClick={openAuth}
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-black font-bold gap-1.5 h-11 shadow-lg shadow-emerald-500/20"
            >
              Claim my bonus <ArrowRight className="w-4 h-4" />
            </Button>
            <Button
              onClick={dismiss}
              variant="ghost"
              className="w-full text-muted-foreground hover:text-foreground h-9 text-xs"
            >
              I&rsquo;ll browse first
            </Button>
          </div>

          {/* Trust line */}
          <div className="px-6 pb-5 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium">
            <span>On-chain proof</span>
            <span className="text-muted-foreground/30">·</span>
            <span>18+</span>
            <span className="text-muted-foreground/30">·</span>
            <span>Made in Naija</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BenefitRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-emerald-500/[0.04] border border-emerald-500/15">
      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-foreground leading-tight">{title}</div>
        <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</div>
      </div>
    </div>
  );
}
