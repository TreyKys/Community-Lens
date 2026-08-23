'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Bell, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  pushSupported, mayAsk, recordDecline, hadPushMoment,
  subscribeToPush, registerServiceWorker,
} from '@/lib/pushClient';

// The notification ask.
//
// TIMED, NOT IMMEDIATE. A permission prompt on first page load is the single
// most expensive mistake available here: browsers make a denial effectively
// permanent, so an unexplained prompt does not cost one notification, it costs
// that person forever. This waits for a moment when the answer to "why would I
// want this?" is obvious — right after someone stakes money on something that
// has not happened yet.
//
// The browser's own prompt is never reached until the user has said yes to
// this card, which explains what they are agreeing to in the user's own terms.
// Two dialogs is worth it: the browser's is unskinnable, unexplained, and
// one-shot.

export function PushGate() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  // Silently keep an existing subscription fresh on every visit. Subscriptions
  // rotate on the browser's schedule; a device that quietly went stale looks
  // exactly like one that never subscribed, and nobody finds out until they
  // stop getting notifications they never knew they had.
  const refresh = useCallback(async (key: string) => {
    if (Notification.permission !== 'granted') return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    await subscribeToPush(key, session.access_token);
  }, []);

  useEffect(() => {
    if (!pushSupported()) return;
    let alive = true;

    (async () => {
      // Ask the server whether push is switched on at all. It ships before the
      // VAPID keys exist, and a card offering a feature that cannot work is
      // worse than no card.
      let key = '';
      try {
        const r = await fetch('/api/push/subscribe', { cache: 'no-store' });
        const j = await r.json();
        if (!j?.configured || !j?.publicKey) return;
        key = String(j.publicKey);
      } catch { return; }
      if (!alive) return;
      setPublicKey(key);

      // Register regardless of permission: the worker has to exist before a
      // subscription can, and registering is silent.
      await registerServiceWorker();
      if (!alive) return;

      if (Notification.permission === 'granted') { await refresh(key); return; }
      if (Notification.permission === 'denied') return;
      if (!mayAsk()) return;

      const { data: { session } } = await supabase.auth.getSession();
      if (!alive || !session?.user) return;

      // Someone who has already staked has a reason to want this, so ask on
      // this visit. Everyone else waits for the moment.
      if (hadPushMoment()) setVisible(true);
    })();

    const onMoment = () => {
      // Not immediately: the stake confirmation is still on screen and its
      // whole job is to be the only thing there. Landing a permission card on
      // top of the celebration turns the best beat in the product into a
      // negotiation.
      setTimeout(() => {
        if (!alive) return;
        if (Notification.permission !== 'default' || !mayAsk()) return;
        setVisible(true);
      }, 3200);
    };
    window.addEventListener('opinionsng:push-moment', onMoment);

    return () => { alive = false; window.removeEventListener('opinionsng:push-moment', onMoment); };
  }, [refresh]);

  const accept = async () => {
    if (!publicKey || busy) return;
    setBusy(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) await subscribeToPush(publicKey, session.access_token);
    setBusy(false);
    setVisible(false);
  };

  const decline = () => {
    recordDecline();
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      className={cn(
        // Above the floating dock, below modals. Anchored bottom on mobile so
        // it sits in the thumb's reach rather than at the top of a phone.
        'fixed z-[80] left-3 right-3 bottom-20 sm:left-auto sm:right-4 sm:bottom-4 sm:w-80',
        'rounded-2xl border border-emerald-500/25 bg-popover p-4',
        'shadow-[0_0_50px_-14px_rgba(27,202,121,0.5)]',
        'animate-in fade-in slide-in-from-bottom-4 duration-300',
      )}
      role="dialog"
      aria-label="Turn on notifications"
    >
      <button
        onClick={decline}
        aria-label="Not now"
        className="absolute top-2.5 right-2.5 text-muted-foreground hover:text-foreground p-1"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex gap-3">
        <div className="shrink-0 w-10 h-10 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/30 flex items-center justify-center">
          <Bell className="w-5 h-5 text-emerald-300" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 pr-4">
          <p className="text-sm font-semibold leading-tight">Know the moment it settles</p>
          {/* Concrete, and only things we actually send. A vague "stay
              updated" is what people decline. */}
          <p className="text-[11px] text-muted-foreground leading-snug mt-1">
            We&rsquo;ll ping you when a result lands, when money hits your wallet,
            and when a market you&rsquo;re in needs a decision. Nothing else.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-3">
        <Button
          size="sm"
          className="flex-1 bg-emerald-600 hover:bg-emerald-500"
          onClick={accept}
          disabled={busy}
        >
          {busy ? 'Turning on…' : 'Turn on'}
        </Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={decline}>
          Not now
        </Button>
      </div>
    </div>
  );
}
