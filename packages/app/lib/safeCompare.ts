import crypto from 'crypto';

/**
 * Constant-time string comparison for secrets.
 *
 * A plain `a === b` short-circuits on the first differing byte, so the time it
 * takes to reject leaks how many leading characters were correct. Over enough
 * requests that's a byte-at-a-time oracle for guessing an admin or cron secret.
 * crypto.timingSafeEqual compares every byte regardless, so the duration no
 * longer depends on how much of the guess was right.
 *
 * Notes:
 *  - timingSafeEqual throws if the buffers differ in length, which would itself
 *    leak the secret's length. We hash both sides to a fixed-width digest first,
 *    so every comparison is over 32 bytes no matter the inputs.
 *  - Returns false for null/undefined/non-string input rather than throwing, so
 *    callers can pass a possibly-missing header straight in.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Empty secrets are never valid — otherwise a missing env var would make an
  // empty header authenticate.
  if (a.length === 0 || b.length === 0) return false;

  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Convenience wrapper: does this request header match the expected secret?
 * Returns false when the expected secret is unset, so a missing env var fails
 * closed instead of authenticating everyone.
 */
export function safeSecretMatch(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  return safeEqual(provided, expected);
}
