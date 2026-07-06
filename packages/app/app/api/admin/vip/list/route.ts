import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/vip/list
//
// Returns the most recent VIP users + their owned referral codes.
// Built because the admin page's "active VIPs" panel previously used
// the browser supabase client (anon key) and silently returned empty
// under RLS — even after a VIP was successfully created server-side.
//
// Service role bypasses RLS so this works regardless of the public
// policy state.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { data: vips } = await supabaseAdmin
      .from('users')
      .select('id, email, created_at, is_vip, bonus_balance, points, last_active_at')
      .eq('is_vip', true)
      .order('created_at', { ascending: false })
      .limit(30);

    const ids = (vips || []).map(v => v.id);
    let codesByVip: Record<string, any[]> = {};
    if (ids.length > 0) {
      const { data: codes } = await supabaseAdmin
        .from('referral_codes')
        .select('code, owner_user_id, is_vip_code, rake_share_pct, signup_bonus_tngn, uses_count, is_active')
        .in('owner_user_id', ids);
      for (const c of codes || []) {
        const oid = c.owner_user_id as string;
        (codesByVip[oid] = codesByVip[oid] || []).push(c);
      }
    }

    const vipsWithCodes = (vips || []).map(v => ({
      ...v,
      referral_codes: codesByVip[v.id] || [],
    }));

    return NextResponse.json({ generatedAt: new Date().toISOString(), vips: vipsWithCodes });
  } catch (e: any) {
    console.error('admin vip list error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
