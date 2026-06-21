import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/reserve-health
//
// Surfaces the house reserve state, aggregate liability across all
// locked-odds markets, and the count of open locked-odds markets —
// the inputs the admin Reserve Health panel needs.
//
// Wraps two service-role-only tables (house_reserve, market_liability)
// behind an admin-authenticated endpoint so the panel doesn't have to
// punch through RLS from the browser. Mirrors the same pattern as
// /api/admin/analytics, /api/admin/owner-activity, etc.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [reserveRes, openMarketsRes, liabilityRes] = await Promise.all([
      supabaseAdmin.from('reserve_health').select('total_tngn, floor_tngn, deployable_tngn').maybeSingle(),
      supabaseAdmin
        .from('markets')
        .select('id', { count: 'exact', head: true })
        .eq('is_locked_odds', true)
        .eq('status', 'open'),
      supabaseAdmin.from('market_liability').select('worst_case_tngn'),
    ]);

    const reserve = reserveRes.data;
    if (!reserve) {
      // house_reserve singleton missing — shouldn't happen after Phase 1
      // migration, but defend rather than 500.
      return NextResponse.json({
        deployable: 0,
        floor: 0,
        total: 0,
        aggregateWorstCase: 0,
        lockedOddsMarketCount: 0,
      });
    }

    const aggregateWorstCase = (liabilityRes.data || []).reduce(
      (a, r: any) => a + Number(r.worst_case_tngn || 0),
      0,
    );

    return NextResponse.json({
      deployable: Number(reserve.deployable_tngn || 0),
      floor: Number(reserve.floor_tngn || 0),
      total: Number(reserve.total_tngn || 0),
      aggregateWorstCase,
      lockedOddsMarketCount: openMarketsRes.count || 0,
    });
  } catch (e: any) {
    console.error('reserve-health failed:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
