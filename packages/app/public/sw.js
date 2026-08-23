/* Opinions.ng service worker.
 *
 * DELIBERATELY DOES NOT CACHE ANYTHING.
 *
 * This worker exists for one reason: a browser will not hand out a push
 * subscription without one. It is tempting to also add offline caching while
 * we're here, and that temptation is how a service worker starts serving a
 * three-week-old copy of a live market page to someone trying to trade. Prices
 * move by the second here; a stale shell is worse than no shell. If offline
 * support is ever wanted it needs its own design, not a fetch handler
 * smuggled in on the back of push.
 *
 * Version bump this comment's date to force an update if the worker ever
 * changes: browsers byte-compare the file.
 * v1 — 2026-08
 */

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close.
  // Without this, a fix to this file lands whenever the user next closes the
  // whole browser, which for a phone is approximately never.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  // A push with no readable payload still has to show SOMETHING. Chrome
  // revokes push permission from origins that receive a push and display no
  // notification, so a parse failure that silently returned would eventually
  // turn push off for that user permanently.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || 'Opinions.ng';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Grouping by tag means five settlements in one minute replace each other
    // instead of stacking five rows on the lock screen.
    tag: data.tag || 'opinionsng',
    renotify: false,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an existing tab and navigate it rather than opening a second
      // copy of the app. Someone who already has it open does not want two.
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('pushsubscriptionchange', event => {
  // The push service can retire a subscription on its own schedule. If we do
  // nothing that device goes silent and neither side notices.
  //
  // A service worker cannot read the Supabase session — it lives in
  // localStorage, which workers have no access to — so this call carries no
  // bearer token and CANNOT be authenticated the usual way. It proves itself
  // instead by presenting the OLD subscription's endpoint and auth secret:
  // anyone holding both could already decrypt this user's pushes, so requiring
  // them gives away nothing, while a caller with only a guessed endpoint
  // cannot redirect someone else's notifications to a device they control.
  //
  // The server treats it as a MOVE of an existing row, never as a new
  // registration, for the same reason.
  event.waitUntil(
    (async () => {
      try {
        const old = event.oldSubscription;
        if (!old) return;
        const oldJson = old.toJSON();

        const key = (event.newSubscription && event.newSubscription.options.applicationServerKey)
          || old.options.applicationServerKey;
        if (!key) return;

        const sub = event.newSubscription
          || (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          }));

        await fetch('/api/push/rotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldEndpoint: oldJson.endpoint,
            oldAuth: oldJson.keys && oldJson.keys.auth,
            subscription: sub.toJSON(),
          }),
        });
      } catch {
        /* Nothing useful to do here — the next visit re-registers with a
           properly authenticated request, which is the real safety net. */
      }
    })(),
  );
});
