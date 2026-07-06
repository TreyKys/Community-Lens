'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Crown, Sparkles, CheckCircle2, ArrowRight } from 'lucide-react';

// Captures the referral code into localStorage (locked) the moment the
// invitee lands, then opens the existing Navbar AuthModal via the shared
// open-auth event. The lock flag tells AuthModal to prefill the code AND
// make the field read-only, so the invitee can't swap in a different
// code (or clear it) — the invite that paid for this acquisition is the
// one that gets credited.

// Keys shared with AuthModal. PENDING is the existing redeem channel;
// LOCKED is the new "came from an invite link, don't let them edit it"
// flag.
const PENDING_KEY = 'pending_referral_code';
const LOCKED_KEY = 'referral_locked';
const AUTH_OPEN_EVENT = 'opinionsng:open-auth';

export function ReferralLandingClient({
  code,
  handle,
  isVip,
  bonus,
  valid,
}: {
  code: string;
  handle: string | null;
  isVip: boolean;
  bonus: number;
  valid: boolean;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // Stash + lock the code regardless of validity — the redeem endpoint
    // is the real validator. A bad code just no-ops there; a good one
    // survives the round-trip through signup.
    try {
      localStorage.setItem(PENDING_KEY, code);
      localStorage.setItem(LOCKED_KEY, '1');
    } catch { /* private mode / storage disabled — degrade gracefully */ }

    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSignedIn(!!data.session);
    });
    return () => { alive = false; };
  }, [code]);

  const accent = isVip ? 'text-amber-400' : 'text-emerald-400';
  const accentBorder = isVip ? 'border-amber-500/30' : 'border-emerald-500/30';
  const Icon = isVip ? Crown : Sparkles;

  const openSignup = () => {
    try { window.dispatchEvent(new Event(AUTH_OPEN_EVENT)); } catch { /* no-op */ }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4">
      <div className="fixed inset-0 z-0 pointer-events-none opacity-40">
        <div className={`absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full blur-[150px] ${isVip ? 'bg-amber-500/15' : 'bg-emerald-500/15'}`} />
      </div>

      <div className="relative z-10 w-full max-w-md space-y-6 text-center py-10">
        {/* The unfurl card, rendered inline so the page matches the link
            preview exactly. */}
        <div className={`rounded-2xl border ${accentBorder} overflow-hidden shadow-2xl`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/referral-card/${encodeURIComponent(code)}`}
            alt={handle ? `@${handle}'s invite` : 'Opinions.ng invite'}
            className="w-full"
            width={1200}
            height={630}
          />
        </div>

        <div className="space-y-2">
          <div className={`inline-flex items-center gap-1.5 text-xs font-semibold ${accent}`}>
            <Icon className="w-3.5 h-3.5" />
            {isVip ? 'VIP Invite' : 'You&rsquo;ve been invited'}
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {handle ? <>@{handle} invited you to Opinions.ng</> : 'Join Opinions.ng'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Nigeria&rsquo;s event-prediction market. Football, politics, crypto, the economy —
            take a position and get paid for being right.
          </p>
        </div>

        {/* The locked code chip — reassures the invitee it's already applied. */}
        <div className={`flex items-center justify-center gap-2 rounded-xl border ${accentBorder} bg-background/40 px-4 py-3`}>
          <CheckCircle2 className={`w-4 h-4 ${accent}`} />
          <span className="text-sm text-muted-foreground">Code applied:</span>
          <span className="font-mono font-bold tracking-widest">{code}</span>
        </div>

        {bonus > 0 && (
          <p className={`text-sm font-semibold ${accent}`}>
            Sign up to claim your ₦{bonus.toLocaleString()} bonus.
          </p>
        )}

        {signedIn ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              You&rsquo;re already signed in — referral codes only apply to brand-new accounts.
            </p>
            <Link href="/markets">
              <Button className="w-full h-12 rounded-xl font-semibold">
                Browse markets <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </div>
        ) : (
          <Button
            onClick={openSignup}
            className="w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold"
          >
            Create my account →
          </Button>
        )}

        <p className="text-[10px] text-muted-foreground/60">
          Your code is locked to this invite. 18+ only. Play responsibly.
        </p>
      </div>
    </div>
  );
}
