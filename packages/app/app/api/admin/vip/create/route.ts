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

    const { userId, email, code, rakeSharePct, preloadBonus } = body || {};

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

    const { data, error } = await supabaseAdmin
      .rpc('admin_create_vip', {
        p_user_id: targetUserId,
        p_custom_code: cleanCode,
        p_rake_share_pct: share,
        p_preload_bonus: preload,
      })
      .single<{ ok: boolean; message: string; code: string | null }>();

    if (error) {
      console.error('admin_create_vip RPC error', error);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }

    if (!data?.ok) {
      const map: Record<string, string> = {
        code_taken: 'That referral code is already taken.',
        code_length: 'Code must be 3–20 characters.',
        invalid_input: 'Invalid input.',
        rake_share_out_of_range: 'Rake share must be 0–50%.',
      };
      return NextResponse.json({ error: map[data?.message || ''] || data?.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      userId: targetUserId,
      code: data.code,
      rakeSharePct: share,
      preloadBonus: preload,
    });
  } catch (e: any) {
    console.error('vip create error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
