'use client';

import { useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';

// Reads a one-shot signup-bonus stash left by AuthModal in sessionStorage
// and fires a celebratory toast. Self-clearing — runs once per session
// and removes the key so a page refresh doesn't re-fire it.
//
// We mount this in the (app) layout (not on the marketing pages) so the
// toast lands on whatever page the new user is dropped onto post-signup.
export function ReferralBonusToast() {
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem('pending_referral_bonus'); } catch { return; }
    if (!raw) return;

    let payload: { amount?: number; at?: number } | null = null;
    try { payload = JSON.parse(raw); } catch { /* fall through */ }
    try { sessionStorage.removeItem('pending_referral_bonus'); } catch {}

    const amount = Number(payload?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return;

    // Tiny delay so the toast lands after the page's own welcome
    // chrome settles — looks like a follow-up reward, not a stack.
    const timeout = setTimeout(() => {
      toast({
        title: `🎉 ₦${amount.toLocaleString()} bonus credit added`,
        description: 'Your referral code dropped credits into your wallet. Use them on your next prediction.',
      });
    }, 600);

    return () => clearTimeout(timeout);
  }, [toast]);

  return null;
}
