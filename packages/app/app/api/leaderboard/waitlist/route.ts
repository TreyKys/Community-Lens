import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Capped slot count drives the FOMO bar on /leaderboard. When we hit it,
// signups halt and the page flips to a "waitlist closed" state. Number
// tuned to feel scarce against the 100-in-48-hours launch target.
const LEADERBOARD_WAITLIST_CAP = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  const { count } = await supabaseAdmin
    .from('leaderboard_waitlist')
    .select('*', { count: 'exact', head: true });

  const taken = count || 0;
  return NextResponse.json({
    taken,
    cap: LEADERBOARD_WAITLIST_CAP,
    remaining: Math.max(0, LEADERBOARD_WAITLIST_CAP - taken),
    closed: taken >= LEADERBOARD_WAITLIST_CAP,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawEmail = String(body?.email || '').trim().toLowerCase();
    const rawPhone = body?.phone ? String(body.phone).trim() : null;
    const source = body?.source ? String(body.source).trim().slice(0, 120) : null;
    const userId = body?.userId ? String(body.userId).trim() : null;

    // Signed-in users send their user_id from the client (we look up email
    // from the users row server-side so we don't trust client-supplied email
    // when a user_id is present).
    let email = rawEmail;
    let resolvedUserId: string | null = null;

    if (userId) {
      const { data: user, error: userErr } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .eq('id', userId)
        .single();
      if (userErr || !user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      resolvedUserId = user.id;
      if (user.email) email = String(user.email).toLowerCase();
    }

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    // Cap check — once we hit LEADERBOARD_WAITLIST_CAP signups, the form locks.
    const { count } = await supabaseAdmin
      .from('leaderboard_waitlist')
      .select('*', { count: 'exact', head: true });
    if ((count || 0) >= LEADERBOARD_WAITLIST_CAP) {
      return NextResponse.json(
        { error: 'Waitlist is full', closed: true },
        { status: 410 }
      );
    }

    // Idempotent: if email already in, return "already in" — drives the
    // "you're already on the list" state on the client.
    const { data: existing } = await supabaseAdmin
      .from('leaderboard_waitlist')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ ok: true, alreadyJoined: true });
    }

    const { error: insertErr } = await supabaseAdmin
      .from('leaderboard_waitlist')
      .insert({
        user_id: resolvedUserId,
        email,
        phone: rawPhone,
        source,
      });
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
