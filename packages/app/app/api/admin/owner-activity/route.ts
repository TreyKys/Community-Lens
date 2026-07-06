import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/owner-activity
//
// Private monitoring panel for owner_accounts. Returns the configured
// owners, their balances, and recent bet activity. Owners now bet
// normally (real stake, real pool participation) so this is regular
// bet activity scoped to the founder cohort — owner_accounts is
// effectively an analytics tag that keeps founder volume out of the
// public KPI surface (see /api/admin/analytics).
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: owners } = await supabaseAdmin
      .from('owner_accounts')
      .select('user_id, active, notes, created_at');

    const ownerIds = (owners || []).map(o => o.user_id);

    if (ownerIds.length === 0) {
      return NextResponse.json({
        generatedAt: new Date().toISOString(),
        owners: [],
        recent: [],
        aggregates: {
          lifetime: { betsCount: 0, stakeTotal: 0, payoutTotal: 0 },
          last24h:  { betsCount: 0, stakeTotal: 0, payoutTotal: 0 },
        },
      });
    }

    const [userRows, recent, lifetimeBets, last24h] = await Promise.all([
      supabaseAdmin
        .from('users')
        .select('id, email, username, first_name, tngn_balance, bonus_balance')
        .in('id', ownerIds),
      supabaseAdmin
        .from('user_bets')
        .select('id, user_id, market_id, outcome_index, stake_tngn, payout_tngn, status, placed_at')
        .in('user_id', ownerIds)
        .order('placed_at', { ascending: false })
        .limit(25),
      supabaseAdmin
        .from('user_bets')
        .select('stake_tngn, payout_tngn, status')
        .in('user_id', ownerIds),
      supabaseAdmin
        .from('user_bets')
        .select('stake_tngn, payout_tngn, status')
        .in('user_id', ownerIds)
        .gte('placed_at', dayAgo),
    ]);

    const usersById = Object.fromEntries((userRows.data || []).map(u => [u.id, u]));

    const recentRows = recent.data || [];
    const marketIds = Array.from(new Set(recentRows.map(r => r.market_id)));
    const { data: marketRows } = marketIds.length > 0
      ? await supabaseAdmin.from('markets').select('id, question, options').in('id', marketIds)
      : { data: [] as any[] };
    const marketsById = Object.fromEntries((marketRows || []).map(m => [m.id, m]));

    const ownersDetailed = (owners || []).map(o => ({
      ...o,
      email:         usersById[o.user_id]?.email ?? null,
      tngn_balance:  Number(usersById[o.user_id]?.tngn_balance ?? 0),
      bonus_balance: Number(usersById[o.user_id]?.bonus_balance ?? 0),
    }));

    const recentDetailed = recentRows.map(r => {
      const u = usersById[r.user_id] as any;
      return {
        ...r,
        market_question: marketsById[r.market_id]?.question ?? null,
        outcome_label:   marketsById[r.market_id]?.options?.[r.outcome_index] ?? null,
        email:           u?.email ?? null,
        username:        u?.username ?? null,
        first_name:      u?.first_name ?? null,
      };
    });

    const sumPayouts = (rows: any[]) => rows
      .filter(r => r.status === 'won')
      .reduce((s, r) => s + Number(r.payout_tngn || 0), 0);
    const sumStakes = (rows: any[]) => rows.reduce((s, r) => s + Number(r.stake_tngn || 0), 0);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      owners: ownersDetailed,
      recent: recentDetailed,
      aggregates: {
        lifetime: {
          betsCount:   (lifetimeBets.data || []).length,
          stakeTotal:  sumStakes(lifetimeBets.data || []),
          payoutTotal: sumPayouts(lifetimeBets.data || []),
        },
        last24h: {
          betsCount:   (last24h.data || []).length,
          stakeTotal:  sumStakes(last24h.data || []),
          payoutTotal: sumPayouts(last24h.data || []),
        },
      },
    });
  } catch (e: any) {
    console.error('admin owner-activity error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
