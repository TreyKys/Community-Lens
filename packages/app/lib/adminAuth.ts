import { cookies } from 'next/headers';
import { safeEqual } from './safeCompare';

export const ADMIN_COOKIE = 'odds_admin';

/**
 * Returns true if the request carries valid admin credentials. Accepts either:
 *   1. A Bearer Authorization header matching ADMIN_SECRET (used by cron + scripts), or
 *   2. The httpOnly admin cookie set by /api/admin/auth.
 *
 * Wrapping both in one helper lets API routes ignore which transport the caller
 * used and lets us drop NEXT_PUBLIC_ADMIN_SECRET from the client bundle.
 */
export function isAdminRequest(request: Request): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;

  // Constant-time comparisons — a plain === leaks how many leading bytes of
  // the guess were correct via response timing, which is a byte-at-a-time
  // oracle for the admin secret.
  const auth = request.headers.get('Authorization');
  if (safeEqual(auth, `Bearer ${expected}`)) return true;

  try {
    const cookie = cookies().get(ADMIN_COOKIE)?.value;
    if (safeEqual(cookie, expected)) return true;
  } catch {
    // cookies() can throw outside a request scope — ignore
  }

  return false;
}
