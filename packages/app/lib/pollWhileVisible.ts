/**
 * lib/pollWhileVisible.ts
 * Background-aware polling helper. Replaces the `setInterval(load, N)` +
 * `clearInterval` pattern at every poll site so that:
 *   - The interval is paused while the browser tab is hidden (the
 *     dominant source of wasted Supabase IO — admins leaving the panel
 *     open in a background tab all day).
 *   - When the tab regains focus, `fn` fires immediately so the user
 *     never sees stale data.
 *
 * Returns a cleanup function — call it from the useEffect cleanup along
 * with whatever `alive` flag the caller uses to guard state setters.
 */
export function pollWhileVisible(fn: () => void, intervalMs: number): () => void {
  // SSR / first-render-before-hydration safety. We don't poll during
  // SSR, but the helper must still return a no-op cleanup so callers
  // can return it unconditionally from useEffect.
  if (typeof document === 'undefined') return () => {};

  let timer: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (timer) return;
    timer = setInterval(fn, intervalMs);
  };
  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      // Catch up immediately on refocus so the UI never lags the data.
      fn();
      start();
    } else {
      stop();
    }
  };

  // Initial fire happens here — callers no longer need to call `load()`
  // before `pollWhileVisible(...)`.
  fn();

  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
