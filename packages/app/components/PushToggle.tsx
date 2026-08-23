'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Bell, BellOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pushSupported, subscribeToPush, unsubscribeFromPush } from '@/lib/pushClient';

// The notifications row on the profile page.
//
// It replaced a row with a chevron on it that led nowhere — which is worse
// than having no row at all, because someone who wants to turn notifications
// off taps it, nothing happens, and the conclusion they draw is that the app
// is broken rather than that the feature is missing.
//
// A visible OFF SWITCH is also what makes the permission ask defensible. It is
// much easier to say yes to something you know you can take back, and someone
// who cannot find the off switch in the app uses the browser's instead — which
// blocks the origin permanently and cannot be undone from in here.

type State = 'loading' | 'unsupported' | 'off' | 'on' | 'blocked';

export function PushToggle() {
  const [state, setState] = useState<State>('loading');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pushSupported()) { setState('unsupported'); return; }
      try {
        const r = await fetch('/api/push/subscribe', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (!j?.configured || !j?.publicKey) { setState('unsupported'); return; }
        setPublicKey(String(j.publicKey));
      } catch { if (alive) setState('unsupported'); return; }

      if (Notification.permission === 'denied') { setState('blocked'); return; }

      // The browser is the source of truth, not the database: someone can
      // clear site data or revoke permission without us ever hearing about it,
      // and a toggle showing "on" for a device that stopped receiving anything
      // is the most misleading state available.
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      if (!alive) return;
      setState(sub && Notification.permission === 'granted' ? 'on' : 'off');
    })();
    return () => { alive = false; };
  }, []);

  const toggle = async () => {
    if (busy || state === 'loading' || state === 'unsupported' || state === 'blocked') return;
    setBusy(true);
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token || '';

    if (state === 'on') {
      await unsubscribeFromPush(token);
      setState('off');
    } else if (publicKey) {
      const res = await subscribeToPush(publicKey, token);
      setState(res === 'subscribed' ? 'on' : res === 'denied' ? 'blocked' : 'off');
    }
    setBusy(false);
  };

  const on = state === 'on';
  const interactive = state === 'off' || state === 'on';

  const detail =
    state === 'blocked'
      ? 'Blocked in your browser settings — turn it back on there'
      : state === 'unsupported'
        ? 'Not available on this browser'
        : on
          ? 'Results, payouts and decisions — on this device'
          : 'Get results and payouts on your phone';

  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className={cn(
          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
          on ? 'bg-emerald-500/10' : 'bg-muted',
        )}>
          {on
            ? <Bell className="w-4 h-4 text-emerald-400" />
            : <BellOff className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">Push notifications</p>
          <p className="text-xs text-muted-foreground truncate">{detail}</p>
        </div>
      </div>

      <button
        onClick={toggle}
        disabled={!interactive || busy}
        role="switch"
        aria-checked={on}
        aria-label="Push notifications"
        className={cn(
          'relative w-11 h-6 rounded-full transition-colors shrink-0 ml-3',
          on ? 'bg-emerald-600' : 'bg-muted',
          !interactive && 'opacity-40 cursor-not-allowed',
        )}
      >
        <span className={cn(
          'absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform',
          on ? 'translate-x-[22px]' : 'translate-x-0.5',
        )} />
      </button>
    </div>
  );
}
