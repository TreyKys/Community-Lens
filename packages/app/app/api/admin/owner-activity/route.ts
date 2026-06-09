import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/owner-activity
//
// Single endpoint that backs the admin "Owner Activity" panel. Returns:
//   - the configured owners (user_id, win_boost_pct, active, balances)
//   - recent shadow bets across all owners (last 25)
//   - aggregate counts (lifetime + 24h) of shadow bets / paid out
//
// Owner accounts are filtered out of the public analytics endpoint, so
// this is the only surface where their activity is observable. Anyone
// hitting this must hold the admin cookie.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [owners, recent, lifetimeBets, last24h] = await Promise.all([
      supabaseAdmin
        .from('owner_accounts')
        .select('user_id, win_boost_pct, active, notes, created_at'),
      // Hit user_bets directly (not the view) so we can join into markets +
      // users for human-readable display without making the view depend on
      // extra columns.
      supabaseAdmin
        .from('user_bets')
        .select('id, user_id, market_id, outcome_index, stake_tngn, payout_tngn, odds_snapshot, status, placed_at')
        .eq('is_shadow_bet', true)
        .order('placed_at', { ascending: false })
        .limit(25),
      supabaseAdmin
        .from('user_bets')
        .select('stake_tngn, payout_tngn, status')
        .eq('is_shadow_bet', true),
      supabaseAdmin
        .from('user_bets')
        .select('stake_tngn, payout_tngn, status')
        .eq('is_shadow_bet', true)
        .gte('placed_at', dayAgo),
    ]);

    const ownerIds = (owners.data || []).map(o => o.user_id);

    // Pull balances + display names in two cheap lookups.
    const { data: userRows } = ownerIds.length > 0
      ? await supabaseAdmin
          .from('users')
          .select('id, email, tngn_balance, bonus_balance')
          .in('id', ownerIds)
      : { data: [] as any[] };

    const usersById = Object.fromEntries((userRows || []).map(u => [u.id, u]));

    // Pull market questions for the recent rows (one query, then join in JS).
    const recentRows = recent.data || [];
    const marketIds = Array.from(new Set(recentRows.map(r => r.market_id)));
    const { data: marketRows } = marketIds.length > 0
      ? await supabaseAdmin.from('markets').select('id, question, options').in('id', marketIds)
      : { data: [] as any[] };
    const marketsById = Object.fromEntries((marketRows || []).map(m => [m.id, m]));

    const ownersDetailed = (owners.data || []).map(o => ({
      ...o,
      email:         usersById[o.user_id]?.email ?? null,
      tngn_balance:  Number(usersById[o.user_id]?.tngn_balance ?? 0),
      bonus_balance: Number(usersById[o.user_id]?.bonus_balance ?? 0),
    }));

    const recentDetailed = recentRows.map(r => ({
      ...r,
      market_question: marketsById[r.market_id]?.question ?? null,
      outcome_label:   marketsById[r.market_id]?.options?.[r.outcome_index] ?? null,
      email:           usersById[r.user_id]?.email ?? null,
    }));

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
