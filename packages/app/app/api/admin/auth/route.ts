import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, isAdminRequest } from '@/lib/adminAuth';

/**
 * POST /api/admin/auth — exchange the admin secret for an httpOnly cookie.
 * Body: { secret: string }
 *
 * Keeps the secret out of the client bundle: only this route ever sees it,
 * and downstream admin requests authenticate via the cookie.
 */
export async function POST(request: Request) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured' }, { status: 500 });
  }

  const { secret } = await request.json().catch(() => ({ secret: '' }));
  if (typeof secret !== 'string' || secret !== expected) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  const res = NextResponse.json({ success: true });
  res.cookies.set({
    name: ADMIN_COOKIE,
    value: expected,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12, // 12h session
  });
  return res;
}

/**
 * GET /api/admin/auth — returns 200 if the caller currently holds a valid
 * admin cookie. Used by the admin shell on mount to skip the password prompt.
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/admin/auth — sign out by clearing the cookie.
 */
export async function DELETE() {
  const res = NextResponse.json({ success: true });
  res.cookies.set({ name: ADMIN_COOKIE, value: '', httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
