// Serialise expensive work so it cannot OOM the container.
//
// Background: we self-host on a 2 GB box with the app container capped
// at 1200 MB (docker-compose.yml). On Netlify each og render was its own
// lambda with its own memory ceiling; now every render shares one heap
// with the process serving live traffic, and `next build` has already
// OOM-killed itself on this hardware once (commit ccea9aa).
//
// An ImageResponse render is satori plus a WASM rasteriser — a large,
// short-lived allocation. A handful running at once can cross the cap.
// The container dies, misses its healthcheck, and Caddy drops it from
// rotation: a share card takes down a live money app. Never a good
// trade, so the renders queue instead.

/**
 * Run `fn` after every previously-queued call has settled.
 *
 * Failures do not wedge the queue — the chain advances on rejection as
 * well as success, and the rejection propagates only to its own caller.
 */
export function createSerialiser() {
  let chain: Promise<unknown> = Promise.resolve();

  return function serialise<T>(fn: () => Promise<T>): Promise<T> {
    // `.then(fn, fn)` runs fn whichever way the previous call settled.
    const next = chain.then(fn, fn);
    // The chain itself must never hold a rejection, or every subsequent
    // caller would inherit an unhandled one.
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
