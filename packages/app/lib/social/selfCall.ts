// Self-call routing and outbound timeouts.
//
// Both of these are consequences of leaving Netlify. On a serverless
// host the platform solved them for us; on a single self-hosted box
// they are ours.
//
// ── 1. Calling ourselves ────────────────────────────────────────────
// The publisher fetches its own card image before posting. Using the
// public URL for that means:
//
//   container -> NAT -> internet -> our own public IP -> Caddy -> TLS
//   -> back into the same container
//
// which is slow (a full TLS handshake for a local file), fragile (it
// needs DNS and a healthy Caddy — during a deploy restart Caddy is
// briefly down, and the media upload fails for no good reason), and on
// some AWS network configurations simply does not work: hairpin NAT to
// your own public IP is not always supported, and the request hangs
// until it times out rather than failing fast.
//
// The container can reach itself directly on 127.0.0.1:3000. The
// healthcheck in docker-compose.yml already does exactly this.
//
// ── 2. Outbound timeouts ────────────────────────────────────────────
// Netlify killed a hung function at its execution cap. Nothing does
// that now. A fetch to Gemini or X with no timeout can hold a socket
// and its memory for minutes after curl and Caddy have both given up on
// the request — on a 1200 MB container that is memory we cannot spare.
// Every outbound call gets an explicit deadline.

/** Where this process can reach itself without leaving the box. */
export function internalBaseUrl(): string {
  return process.env.INTERNAL_APP_URL || 'http://127.0.0.1:3000';
}

/**
 * Rewrite one of our own public URLs to the loopback equivalent.
 *
 * Anything pointing elsewhere is returned untouched, so this is safe to
 * apply blindly to a stored `media_url`.
 */
export function toInternalUrl(url: string): string {
  const publicBase = process.env.NEXT_PUBLIC_APP_URL;
  if (!publicBase) return url;

  try {
    const target = new URL(url);
    const pub = new URL(publicBase);
    if (target.host !== pub.host) return url;
    return `${internalBaseUrl()}${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

/** Default deadline for an outbound call, in ms. */
export const OUTBOUND_TIMEOUT_MS = 20_000;

/**
 * fetch with a hard deadline.
 *
 * AbortSignal.timeout aborts the request itself rather than just
 * abandoning the promise, so the socket and its buffers are actually
 * released — which is the point on a memory-capped container.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = OUTBOUND_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
