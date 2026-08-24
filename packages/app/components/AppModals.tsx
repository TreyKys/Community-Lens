'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Megaphone, X, Flame, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WHATS_NEW, WHATS_NEW_RELEASE } from '@/lib/whatsNew';

// The two return moments: "here's what changed" and "good to see you".
//
// ONE CONTROLLER, because they must never stack. Someone returning after a
// month qualifies for both, and two modals in a row is not a welcome, it is an
// obstacle course. Welcome Back wins that tie — it is warmer, it is personal,
// and What's New will still be waiting on the next visit.
//
// Deliberately NOT shown on the marketing/landing routes or mid-flow. A modal
// that lands while someone is placing a bet is an interruption, not
// engagement.

const SEEN_RELEASE_KEY = 'opinionsng_whatsnew_release';
const LAST_SEEN_KEY = 'opinionsng_last_seen_at';
const AWAY_MS = 12 * 60 * 60 * 1000;   // "back" means a real gap, not a refresh

export function AppModals() {
  const pathname = usePathname();
  const [mode, setMode] = useState<'none' | 'welcome' | 'whatsnew'>('none');
  const [name, setName] = useState<string | null>(null);
  const [awayDays, setAwayDays] = useState(0);

  useEffect(() => {
    // Only on the surfaces someone lands on, never over a form or a flow.
    const ok = ['/markets', '/dashboard', '/bets', '/open', '/bbn'].some(
      p => pathname === p || pathname === `${p}/`,
    );
    if (!ok) return;

    let alive = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!alive) return;

      let lastSeen = 0;
      let seenRelease = '';
      try {
        lastSeen = Number(localStorage.getItem(LAST_SEEN_KEY) || 0);
        seenRelease = localStorage.getItem(SEEN_RELEASE_KEY) || '';
      } catch { /* private mode — treat as first visit and show nothing */ return; }

      const now = Date.now();
      const gap = lastSeen ? now - lastSeen : 0;
      try { localStorage.setItem(LAST_SEEN_KEY, String(now)); } catch {}

      // "Brand new" is decided by whether they have an ACCOUNT, not by
      // localStorage.
      //
      // This key is written only by this component, which did not exist before
      // this release. So on the first load after shipping, every user in the
      // product — including someone who has been here since launch — has no
      // key and looks brand new. The previous version took that at face value,
      // showed nothing, and marked What's New as read on the way out. The
      // result was a modal that could never be seen by anybody, which is
      // exactly what happened.
      //
      // A signed-in session is the honest signal: you cannot have an account
      // and be a first-time visitor.
      if (!lastSeen && !session?.user) {
        try { localStorage.setItem(SEEN_RELEASE_KEY, WHATS_NEW_RELEASE); } catch {}
        return;
      }

      if (session?.user && gap > AWAY_MS) {
        const { data } = await supabase
          .from('users').select('username, first_name')
          .eq('id', session.user.id).maybeSingle();
        if (!alive) return;
        setName((data?.username || data?.first_name || null) as string | null);
        setAwayDays(Math.floor(gap / (24 * 60 * 60 * 1000)));
        setMode('welcome');
        return;
      }

      if (seenRelease !== WHATS_NEW_RELEASE) setMode('whatsnew');
    })();
    return () => { alive = false; };
  }, [pathname]);

  const dismiss = () => {
    // Marking the release seen on ANY dismissal — including from Welcome
    // Back — would hide What's New from the exact person most likely to want
    // it. Only the What's New modal itself records that it was read.
    if (mode === 'whatsnew') {
      try { localStorage.setItem(SEEN_RELEASE_KEY, WHATS_NEW_RELEASE); } catch {}
    }
    setMode('none');
  };

  if (mode === 'none') return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-3 sm:p-6 bg-background/80 backdrop-blur-sm"
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className={cn(
          'relative w-full max-w-sm rounded-2xl border bg-popover overflow-hidden',
          'border-emerald-500/25',
          'shadow-[0_0_60px_-12px_rgba(27,202,121,0.4)]',
          'animate-in fade-in slide-in-from-bottom-4 duration-300',
        )}
      >
        <button
          onClick={dismiss}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 text-muted-foreground hover:text-foreground p-1"
        >
          <X className="w-4 h-4" />
        </button>

        {mode === 'whatsnew' ? <WhatsNewBody onGo={dismiss} /> : (
          <WelcomeBody name={name} awayDays={awayDays} onGo={dismiss} />
        )}
      </div>
    </div>
  );
}

function WhatsNewBody({ onGo }: { onGo: () => void }) {
  return (
    <>
      {/* The neon megaphone. Drawn rather than illustrated: a glow ring behind
          a stroked icon costs nothing to ship, scales cleanly, and cannot
          arrive broken on a slow connection the way an image can. */}
      <div className="relative px-6 pt-8 pb-5 text-center">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_70%_at_50%_0%,rgba(27,202,121,0.18),transparent_70%)]" />
        <div className="relative mx-auto w-14 h-14 rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/30 flex items-center justify-center shadow-[0_0_28px_-4px_rgba(27,202,121,0.55)]">
          <Megaphone className="w-7 h-7 text-emerald-300 -rotate-12" strokeWidth={1.75} />
        </div>
        <h2 className="relative text-lg font-bold mt-3">What&rsquo;s new</h2>
        <p className="relative text-xs text-muted-foreground mt-1">
          A few things landed while you were away.
        </p>
      </div>

      <div className="px-4 pb-4 space-y-1.5 max-h-[46vh] overflow-y-auto">
        {WHATS_NEW.map(item => (
          <div key={item.title} className="flex gap-3 rounded-xl p-2.5 hover:bg-muted/30 transition-colors">
            <span className="text-lg leading-none shrink-0 mt-0.5">{item.emoji}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-snug">{item.title}</p>
              <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{item.body}</p>
              {item.href && (
                <Link href={item.href} onClick={onGo}
                      className="inline-flex items-center gap-0.5 text-[11px] text-emerald-400 hover:underline mt-1">
                  {item.cta} <ArrowRight className="w-3 h-3" />
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 pt-0">
        <Button className="w-full bg-emerald-600 hover:bg-emerald-500" onClick={onGo}>
          Got it
        </Button>
      </div>
    </>
  );
}

function WelcomeBody({ name, awayDays, onGo }: {
  name: string | null; awayDays: number; onGo: () => void;
}) {
  // The away line is the only genuinely personal thing here, so it should not
  // overclaim. Under a day gets no line at all rather than a fake "it's been
  // 0 days".
  const away = awayDays >= 1
    ? `It's been ${awayDays === 1 ? 'a day' : `${awayDays} days`}.`
    : null;

  return (
    <>
      <div className="relative px-6 pt-8 pb-5 text-center">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_70%_at_50%_0%,rgba(245,158,11,0.16),transparent_70%)]" />
        <div className="relative mx-auto w-14 h-14 rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/30 flex items-center justify-center shadow-[0_0_28px_-4px_rgba(245,158,11,0.5)]">
          <Flame className="w-7 h-7 text-amber-300" strokeWidth={1.75} />
        </div>
        <h2 className="relative text-lg font-bold mt-3">
          Welcome back{name ? `, ${name}` : ''}
        </h2>
        <p className="relative text-xs text-muted-foreground mt-1">
          {away ? `${away} The markets kept moving.` : 'The markets kept moving.'}
        </p>
      </div>

      <div className="px-4 pb-2 space-y-2">
        {/* Three concrete things to do, not a greeting and a dead end. Each one
            is a live surface rather than a marketing line. */}
        <Link href="/markets" onClick={onGo}
              className="flex items-center justify-between gap-2 rounded-xl border border-border/60 p-3 hover:border-emerald-500/40 transition-colors">
          <div className="min-w-0">
            <p className="text-xs font-semibold">See what moved</p>
            <p className="text-[11px] text-muted-foreground">The biggest swings in the last 24 hours</p>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </Link>

        <Link href="/dashboard" onClick={onGo}
              className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] p-3 hover:border-emerald-500/50 transition-colors">
          <div className="min-w-0">
            <p className="text-xs font-semibold">Your streaks are waiting</p>
            <p className="text-[11px] text-muted-foreground">Show up 7 days running for ₦200 bonus</p>
          </div>
          <ArrowRight className="w-4 h-4 text-emerald-400 shrink-0" />
        </Link>

        <Link href="/open" onClick={onGo}
              className="flex items-center justify-between gap-2 rounded-xl border border-border/60 p-3 hover:border-emerald-500/40 transition-colors">
          <div className="min-w-0">
            <p className="text-xs font-semibold">Trading is new</p>
            <p className="text-[11px] text-muted-foreground">Buy a side, sell before the answer</p>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
        </Link>
      </div>

      <div className="p-4">
        <Button variant="outline" className="w-full" onClick={onGo}>
          Have a look around
        </Button>
      </div>
    </>
  );
}
