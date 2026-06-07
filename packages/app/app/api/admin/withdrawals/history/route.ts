import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/admin/withdrawals/history
 *
 * Full withdrawal ledger for admin tracking — every status, not just pending.
 * Lets ops audit completed payouts, chase failed transfers, and review
 * rejection reasons. Capped to the most recent 200 to keep payload sane.
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from('withdrawals')
    .select('id, user_id, amount_tngn, naira_to_send, bank_code, account_number, account_name, status, gateway, gateway_transfer_code, admin_note, created_at, approved_at, processed_at')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const userIds = Array.from(new Set((data || []).map((w: any) => w.user_id).filter(Boolean)));
  const userMap = new Map<string, { email?: string; username?: string }>();
  if (userIds.length) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, email, username')
      .in('id', userIds);
    for (const u of users || []) userMap.set(u.id, { email: u.email, username: u.username });
  }

  const hydrated = (data || []).map((w: any) => ({ ...w, user: userMap.get(w.user_id) || null }));

  return NextResponse.json({ withdrawals: hydrated });
}
