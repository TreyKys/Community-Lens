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
    const [reserveRes, openMarketsRes, liabilityRes, slipRes] = await Promise.all([
      supabaseAdmin.from('reserve_health').select('total_tngn, floor_tngn, deployable_tngn').maybeSingle(),
      supabaseAdmin
        .from('markets')
        .select('id', { count: 'exact', head: true })
        .eq('is_locked_odds', true)
        .eq('status', 'open'),
      supabaseAdmin.from('market_liability').select('worst_case_tngn'),
      // Open Multiplier liability — the house's potential payout on every
      // active slip. The reserve only reflects realised P&L, so this is
      // shown separately so the admin sees true open exposure.
      supabaseAdmin.from('multiplier_slips').select('payout_tngn').eq('status', 'active'),
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
    const openSlipLiability = (slipRes.data || []).reduce(
      (a, r: any) => a + Number(r.payout_tngn || 0),
      0,
    );

    return NextResponse.json({
      deployable: Number(reserve.deployable_tngn || 0),
      floor: Number(reserve.floor_tngn || 0),
      total: Number(reserve.total_tngn || 0),
      aggregateWorstCase,
      openSlipLiability,
      lockedOddsMarketCount: openMarketsRes.count || 0,
    });
  } catch (e: any) {
    console.error('reserve-health failed:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// POST /api/admin/reserve-health — the one lever this panel didn't have.
//
// Until this existed, adding capital to house_reserve.total_tngn meant a
// hand-typed UPDATE in the SQL editor — which happened for real on
// 2026-09-08, because the reserve had drifted below its own floor with
// nothing due to settle for 51 days and there was no button for it. This
// wraps the same admin_topup_house_reserve RPC the SQL Editor was calling
// by hand, with the same mandatory reason and the same audit trail every
// other money movement on this platform leaves in treasury_log.
//
// No admin-identity parameter, unlike the Open Markets admin controls —
// this page's actions have never carried one (isAdminRequest is a single
// shared secret, not per-admin accounts). Matches /api/admin/credits'
// existing convention instead: a mandatory reason and a sanity cap.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = String(body?.action || '');

  switch (action) {
    case 'topup': {
      const amount = Number(body?.amountTngn);
      const reason = String(body?.reason || '').trim();
      const { data, error } = await supabaseAdmin.rpc('admin_topup_house_reserve', {
        p_amount_tngn: amount,
        p_reason: reason,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied) {
        return NextResponse.json({ error: row?.reason || 'Could not top up reserve' }, { status: 400 });
      }
      return NextResponse.json({
        newTotal: Number(row.new_total_tngn),
        newDeployable: Number(row.new_deployable_tngn),
      });
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
