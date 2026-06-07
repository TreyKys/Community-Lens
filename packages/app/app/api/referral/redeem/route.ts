import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST { code } — redeems a referral code for the calling user.
// Atomic via redeem_referral_code RPC. Handles both normal and VIP codes,
// no self-referrals, idempotent (re-running with the same code is a no-op).
export async function POST(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = auth.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 });
    }

    const code = String(body?.code || '').trim();
    if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });
    if (code.length > 32) return NextResponse.json({ error: 'code too long' }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .rpc('redeem_referral_code', { p_user_id: user.id, p_code: code })
      .single<{ ok: boolean; message: string; owner_id: string | null; is_vip_code: boolean }>();

    if (error) {
      console.error('redeem_referral_code RPC error', error);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Internal error' }, { status: 500 });

    if (!data.ok) {
      // Map RPC validation failures to 400 with a friendly message
      const map: Record<string, string> = {
        code_not_found: 'That referral code is invalid.',
        code_inactive:  'That referral code is no longer active.',
        self_referral:  'You can\'t use your own code.',
        invalid_input:  'Code is required.',
      };
      return NextResponse.json({ error: map[data.message] || data.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      alreadyRedeemed: data.message === 'already_redeemed',
      isVipCode: data.is_vip_code,
    });
  } catch (e: any) {
    console.error('referral redeem error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
