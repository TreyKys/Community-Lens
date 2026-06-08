import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/admin/markets/distributions?ids=1,2,3
 *
 * Returns per-market vote/stake distributions for the resolve page. Built
 * because the page used to query user_bets via the anon client, which
 * stopped working after migration 20240621 locked down user_bets RLS to
 * own-rows-only. Now the aggregation runs server-side with service_role.
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get('ids') || '';
  const ids = idsParam.split(',').map(s => Number(s)).filter(n => Number.isFinite(n));
  if (!ids.length) return NextResponse.json({ distributions: {} });

  const { data: bets, error } = await supabaseAdmin
    .from('user_bets')
    .select('market_id, outcome_index, net_stake_tngn')
    .in('market_id', ids)
    .eq('status', 'active');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pre-aggregate by (market_id, outcome_index) so the client just maps it.
  const out: Record<number, Record<number, { count: number; stake: number }>> = {};
  for (const b of bets || []) {
    const mid = (b as any).market_id;
    const oi = (b as any).outcome_index;
    if (!out[mid]) out[mid] = {};
    if (!out[mid][oi]) out[mid][oi] = { count: 0, stake: 0 };
    out[mid][oi].count += 1;
    out[mid][oi].stake += Number((b as any).net_stake_tngn || 0);
  }

  return NextResponse.json({ distributions: out });
}
