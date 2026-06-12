import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/admin/vip/create
// Body: { userId | email, code, rakeSharePct, preloadBonus }
// Admin-only. Promotes a user to VIP, mints/repurposes their custom referral
// code, sets their resolution-rake revenue share (% of rake from their
// referred users' bets), and credits a preload of bonus_balance.
export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

    const { userId, email, code, rakeSharePct, preloadBonus, signupBonus } = body || {};

    if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });
    if (!userId && !email) return NextResponse.json({ error: 'userId or email required' }, { status: 400 });

    const cleanCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanCode.length < 3 || cleanCode.length > 20) {
      return NextResponse.json({ error: 'Code must be 3–20 alphanumeric characters' }, { status: 400 });
    }

    const share = Number(rakeSharePct);
    if (!Number.isFinite(share) || share < 0 || share > 50) {
      return NextResponse.json({ error: 'rakeSharePct must be between 0 and 50' }, { status: 400 });
    }

    const preload = Number(preloadBonus || 0);
    if (preload < 0 || preload > 1_000_000) {
      return NextResponse.json({ error: 'preloadBonus out of range' }, { status: 400 });
    }

    // Signup bonus = amount future new users receive when they redeem
    // this VIP's code. Defaults to ₦500 server-side if unset; capped at
    // ₦5,000 by the RPC's CHECK constraint on referral_codes.
    const signup = signupBonus === undefined || signupBonus === null || signupBonus === ''
      ? undefined
      : Number(signupBonus);
    if (signup !== undefined && (!Number.isFinite(signup) || signup < 0 || signup > 5_000)) {
      return NextResponse.json({ error: 'signupBonus must be between 0 and 5000' }, { status: 400 });
    }

    // Resolve target user
    let targetUserId: string | null = userId || null;
    if (!targetUserId && email) {
      const { data: u } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('email', String(email).trim().toLowerCase())
        .maybeSingle();
      if (!u) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      targetUserId = u.id;
    }

    const rpcArgs: Record<string, unknown> = {
      p_user_id: targetUserId,
      p_custom_code: cleanCode,
      p_rake_share_pct: share,
      p_preload_bonus: preload,
    };
    if (signup !== undefined) rpcArgs.p_signup_bonus_tngn = signup;

    const { data, error } = await supabaseAdmin
      .rpc('admin_create_vip', rpcArgs)
      .single<{ ok: boolean; message: string; code: string | null }>();

    if (error) {
      console.error('admin_create_vip RPC error', error);
      // Surface the actual Postgres error to the client so we don't
      // pretend success when the RPC just blew up.
      return NextResponse.json({ error: error.message || 'RPC error' }, { status: 500 });
    }

    if (!data?.ok) {
      const map: Record<string, string> = {
        invalid_input:               'Invalid input.',
        rake_share_out_of_range:     'Rake share must be 0–50%.',
        preload_bonus_out_of_range:  'Preload bonus out of range (0–1,000,000).',
        signup_bonus_out_of_range:   'Signup bonus out of range (0–5,000).',
        code_length_invalid:         'Code must be 3–32 characters.',
        code_taken:                  'That referral code is already taken.',
      };
      return NextResponse.json({ error: map[data?.message || ''] || data?.message || 'Unknown failure' }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      userId: targetUserId,
      code: data.code,
      rakeSharePct: share,
      preloadBonus: preload,
      signupBonus: signup ?? null,
    });
  } catch (e: any) {
    console.error('vip create error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
