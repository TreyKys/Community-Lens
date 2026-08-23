import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normalizeNigerianPhone, verifyOtp } from '@/lib/termii';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/auth/phone/verify-otp
 *
 * Verifies the Termii pin, then signs the user into a Supabase account keyed
 * by phone number. Supabase has no "verify externally, mint session" primitive,
 * so we bridge it with a one-time random password: generate it, set it on the
 * (looked-up-or-created) auth user, sign in with it server-side, and hand the
 * resulting session back to the client. The password is never exposed.
 */
export async function POST(request: Request) {
  try {
    const { phone, pinId, pin } = await request.json();
    if (!phone || !pinId || !pin) {
      return NextResponse.json({ error: 'Missing phone, pinId, or pin' }, { status: 400 });
    }

    const normalized = normalizeNigerianPhone(String(phone));
    if (!normalized) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }

    const verified = await verifyOtp(String(pinId), String(pin));
    if (!verified) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 });
    }

    const bridgePassword = randomBytes(24).toString('base64url');
    const phoneForAuth = normalized.replace(/^\+/, '');

    // Look up an existing account by phone via our own users table (mirrors auth.users via trigger).
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('phone', normalized)
      .maybeSingle();

    if (existing?.id) {
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
        password: bridgePassword,
      });
      if (updateError) throw updateError;

      // The OTP just proved this number belongs to whoever is holding the
      // phone, which is exactly the condition the ₦200 phone reward was held
      // against. Releases it if one is pending, and is a no-op otherwise.
      //
      // Non-fatal on purpose: a failure here must not block a sign-in that has
      // already succeeded. The reward stays pending and releases on the next
      // verification.
      try {
        await supabaseAdmin.rpc('release_verified_phone_reward', { p_user_id: existing.id });
      } catch { /* sign-in matters more than the bonus */ }
    } else {
      const { error: createError } = await supabaseAdmin.auth.admin.createUser({
        phone: phoneForAuth,
        password: bridgePassword,
        phone_confirm: true,
      });
      if (createError) throw createError;
    }

    const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
      phone: phoneForAuth,
      password: bridgePassword,
    });
    if (signInError || !signInData?.session) {
      throw signInError || new Error('Could not start session');
    }

    return NextResponse.json({
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
    });
  } catch (error: any) {
    console.error('Phone OTP verify error:', error);
    return NextResponse.json({ error: error.message || 'Verification failed' }, { status: 500 });
  }
}
