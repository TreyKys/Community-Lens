// Web push, browser side.
//
// THE ONE RULE THAT MATTERS: never call Notification.requestPermission()
// unprompted. A browser permission denial is close to permanent — there is no
// second chance and most people cannot find the setting to undo it — so an
// unexplained prompt on page load does not cost you one notification, it costs
// you that person forever. Every path here asks only after the user has said
// yes to a card that explains what they are agreeing to.

const DECLINE_KEY = 'opinionsng_push_declined';
const ASKS_KEY = 'opinionsng_push_asks';
const MOMENT_KEY = 'opinionsng_push_moment';

// Backing off after a decline, and giving up after three. Someone who has said
// "not now" three times has said no.
const BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ASKS = 3;

const read = (k: string): string => {
  try { return localStorage.getItem(k) || ''; } catch { return ''; }
};
const write = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
};

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** Mark that something just happened worth being notified about. */
export function notePushMoment() {
  write(MOMENT_KEY, '1');
  try {
    window.dispatchEvent(new CustomEvent('opinionsng:push-moment'));
  } catch { /* older browsers — the flag still works on the next load */ }
}

export function hadPushMoment(): boolean {
  return read(MOMENT_KEY) === '1';
}

export function recordDecline() {
  write(DECLINE_KEY, String(Date.now()));
  write(ASKS_KEY, String(Number(read(ASKS_KEY) || 0) + 1));
}

export function mayAsk(): boolean {
  if (Number(read(ASKS_KEY) || 0) >= MAX_ASKS) return false;
  const last = Number(read(DECLINE_KEY) || 0);
  return !last || Date.now() - last > BACKOFF_MS;
}

// base64url → Uint8Array. The push API wants raw bytes for the VAPID key and
// the key is distributed as base64url, which atob does not handle: it rejects
// the '-' and '_' that base64url uses in place of '+' and '/'.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  // Allocated over an explicit ArrayBuffer rather than `new Uint8Array(len)`:
  // the DOM's BufferSource will not accept a view that might be backed by a
  // SharedArrayBuffer, which is what the plain constructor's type allows.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

type SubscribeResult = 'subscribed' | 'denied' | 'unsupported' | 'failed';

/**
 * Subscribe this browser and tell the server about it.
 *
 * Safe to call on every visit: subscriptions rotate on the browser's own
 * schedule and the server upserts on the endpoint, so re-registering is one
 * cheap write that keeps a stale row from silently swallowing notifications.
 *
 * `token` is the Supabase access token — the route is bearer-authenticated.
 */
export async function subscribeToPush(
  publicKey: string,
  token: string,
): Promise<SubscribeResult> {
  if (!pushSupported() || !publicKey || !token) return 'unsupported';

  const reg = await registerServiceWorker();
  if (!reg) return 'failed';

  // Waiting for the worker to actually control the page. Calling subscribe()
  // against a registration that is still installing throws on some browsers.
  try { await navigator.serviceWorker.ready; } catch { /* proceed anyway */ }

  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') {
    const res = await Notification.requestPermission();
    if (res !== 'granted') {
      recordDecline();
      return 'denied';
    }
  }

  try {
    // Reuse whatever the browser already has. A fresh subscribe() when one
    // exists is fine, but re-using avoids churning the endpoint (and so the
    // database row) on every single visit.
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || (await reg.pushManager.subscribe({
      // Required by Chrome. It is also the honest setting: everything we send
      // shows the user something.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

    const r = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return r.ok ? 'subscribed' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function unsubscribeFromPush(token: string): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return true;

    // Tell the server FIRST. If the order were reversed and the request
    // failed, the browser would have dropped the subscription while the server
    // kept pushing to a dead endpoint until it aged out.
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
    return true;
  } catch {
    return false;
  }
}
