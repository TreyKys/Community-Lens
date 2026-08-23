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

// Five states, not three, because "you can't have this" has three genuinely
// different causes and telling someone the wrong one sends them to fix the
// wrong thing:
//
//   unsupported   — this browser has no Push API at all. Nothing to be done.
//   unconfigured  — WE have not finished setting it up. Nothing THEY can do,
//                   and saying "not available on this browser" here is a lie
//                   that sends people hunting through their settings.
//   needsInstall  — iOS only grants push to a site added to the Home Screen.
//                   This is the one case where there is something to do, and
//                   it is invisible unless we say it.
type State = 'loading' | 'unsupported' | 'unconfigured' | 'needsInstall' | 'off' | 'on' | 'blocked';

// iOS grants push only to a web app launched from the Home Screen. Safari on
// iOS 16.4+ exposes PushManager either way, so feature detection alone reports
// "supported" and then subscribing fails with nothing useful said.
function iosNeedsInstall(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    // iPadOS 13+ reports itself as a Mac; touch points are what give it away.
    || (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
  if (!isIOS) return false;
  const standalone = (window.navigator as any).standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  return !standalone;
}

export function PushToggle() {
  const [state, setState] = useState<State>('loading');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Server config is checked FIRST. If we have not switched push on, that
      // is the true answer regardless of what browser they are using.
      let key = '';
      try {
        const r = await fetch('/api/push/subscribe', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (!j?.configured || !j?.publicKey) { setState('unconfigured'); return; }
        key = String(j.publicKey);
      } catch { if (alive) setState('unconfigured'); return; }

      if (!pushSupported()) { setState(iosNeedsInstall() ? 'needsInstall' : 'unsupported'); return; }
      if (iosNeedsInstall()) { setState('needsInstall'); return; }
      setPublicKey(key);

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

  // Each message names the thing that would actually change the outcome. The
  // old version said "not available on this browser" for all three, which is
  // the wrong answer twice: it blames Chrome when the fault is ours, and it
  // hides the one instruction that works on iPhone.
  const detail =
    state === 'blocked'
      ? 'Blocked in your browser settings — turn it back on there'
      : state === 'unconfigured'
        ? 'Not switched on yet — coming shortly'
        : state === 'needsInstall'
          ? 'Add Opinions.ng to your Home Screen first, then come back here'
          : state === 'unsupported'
            ? 'This browser can’t do notifications'
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
