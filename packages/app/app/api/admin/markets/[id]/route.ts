import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/markets/[id]
//
// Full admin dossier for one market. Critical difference vs. the
// public /api/markets/chart endpoint: this one is NOT scoped to bets
// with status='active'. It returns the distribution + bet ledger
// computed from EVERY bet ever placed on the market — including
// won/lost/refunded ones. Lets admin see exactly what the market
// looked like even after it's resolved or voided.
//
// Data is preserved by virtue of user_bets being permanent — once a
// bet row exists it isn't deleted, only its status changes. So the
// distribution is reconstructible from June 11 onwards for any market
// admin hasn't explicitly nuked via the targeted-delete tool.

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const marketId = Number(params.id);
    if (!Number.isFinite(marketId)) {
      return NextResponse.json({ error: 'id must be a number' }, { status: 400 });
    }

    const { data: market } = await supabaseAdmin
      .from('markets')
      .select('*')
      .eq('id', marketId)
      .maybeSingle();
    if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

    const [bets, snapshots, merkle, parent, children] = await Promise.all([
      // Every bet that ever existed on this market, ordered chronologically.
      // We don't filter by status — that's what makes this different from
      // the public chart endpoint.
      supabaseAdmin
        .from('user_bets')
        .select('id, user_id, outcome_index, stake_tngn, net_stake_tngn, payout_tngn, status, placed_at, is_jackpot_eligible')
        .eq('market_id', marketId)
        .order('placed_at', { ascending: true }),
      // Periodic pool snapshots if the table exists (silently ignore if not).
      supabaseAdmin
        .from('market_snapshots')
        .select('total_pool, created_at')
        .eq('market_id', marketId)
        .order('created_at', { ascending: true }),
      // On-chain merkle commits (the cryptographic seal at lock time).
      supabaseAdmin
        .from('merkle_commits')
        .select('root_hash, tx_hash, committed_at')
        .eq('market_id', marketId)
        .order('committed_at', { ascending: false }),
      // Parent market reference (for sub-markets).
      market.parent_market_id
        ? supabaseAdmin
            .from('markets')
            .select('id, question')
            .eq('id', market.parent_market_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Direct children (sub-markets).
      supabaseAdmin
        .from('markets')
        .select('id, question, status, total_pool')
        .eq('parent_market_id', marketId)
        .order('id', { ascending: false }),
    ]);

    const allBets = bets.data || [];
    const options = (market.options as string[]) || [];

    // Resolve bettor emails in one round-trip so admin can see who
    // placed each bet rather than scrolling through UUIDs.
    const bettorIds = Array.from(new Set(allBets.map(b => b.user_id)));
    let bettorsById: Record<string, any> = {};
    if (bettorIds.length > 0) {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('id, email, username, is_vip')
        .in('id', bettorIds);
      bettorsById = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    // ── Distribution computed from ALL bets ──────────────────────────
    // We include every status because admin wants to see the historical
    // picture, not just what's currently active.
    const optionTotals = options.map(() => 0);
    const optionCounts = options.map(() => 0);
    for (const b of allBets) {
      const i = b.outcome_index ?? -1;
      if (i >= 0 && i < options.length) {
        optionTotals[i] += Number(b.net_stake_tngn || 0);
        optionCounts[i] += 1;
      }
    }
    const totalNetPool = optionTotals.reduce((s, v) => s + v, 0);
    const distribution = options.map((opt, i) => ({
      option: opt,
      amount: optionTotals[i],
      bet_count: optionCounts[i],
      percentage: totalNetPool > 0 ? Math.round((optionTotals[i] / totalNetPool) * 100) : 0,
      is_winning: market.resolved_outcome === i,
    }));

    // ── Cumulative timeline (per-outcome running totals over time) ───
    // Bucket bets by hour and accumulate. Looks like the public chart
    // but is computed from every bet, not just active ones.
    const hourMap: Record<string, number[]> = {};
    for (const b of allBets) {
      const hour = new Date(b.placed_at).toISOString().slice(0, 13) + ':00';
      if (!hourMap[hour]) hourMap[hour] = options.map(() => 0);
      hourMap[hour][b.outcome_index] = (hourMap[hour][b.outcome_index] || 0) + Number(b.net_stake_tngn || 0);
    }
    const hours = Object.keys(hourMap).sort();
    const running = options.map(() => 0);
    const timeline: any[] = [];
    for (const hour of hours) {
      options.forEach((_, i) => { running[i] += hourMap[hour][i] || 0; });
      const entry: any = { time: hour, total: running.reduce((s, v) => s + v, 0) };
      options.forEach((opt, i) => { entry[opt] = Math.round(running[i]); });
      timeline.push(entry);
    }

    // ── Aggregates over every bet ────────────────────────────────────
    const wonBets    = allBets.filter(b => b.status === 'won');
    const lostBets   = allBets.filter(b => b.status === 'lost');
    const activeBets = allBets.filter(b => b.status === 'active');
    const refunded   = allBets.filter(b => b.status === 'refunded');
    const summary = {
      total_bets:       allBets.length,
      unique_bettors:   bettorIds.length,
      total_staked:     allBets.reduce((s, b) => s + Number(b.stake_tngn || 0), 0),
      total_net_staked: totalNetPool,
      total_paid_out:   wonBets.reduce((s, b) => s + Number(b.payout_tngn || 0), 0),
      bets_active:      activeBets.length,
      bets_won:         wonBets.length,
      bets_lost:        lostBets.length,
      bets_refunded:    refunded.length,
    };

    // Join bettor info into the bet rows for the bet-ledger table.
    const betsWithBettor = allBets.map(b => ({
      ...b,
      bettor_email: bettorsById[b.user_id]?.email ?? null,
      bettor_username: bettorsById[b.user_id]?.username ?? null,
      bettor_is_vip: !!bettorsById[b.user_id]?.is_vip,
      outcome_label: options[b.outcome_index] ?? null,
    }));

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      market: {
        ...market,
        // Stamp a friendly outcome label on the resolved index for the UI.
        resolved_outcome_label: market.resolved_outcome !== null && market.resolved_outcome !== undefined
          ? options[market.resolved_outcome] ?? null
          : null,
      },
      parent: parent.data ?? null,
      children: children.data ?? [],
      summary,
      distribution,
      timeline,
      bets: betsWithBettor,
      snapshots: snapshots.data ?? [],
      merkle: merkle.data ?? [],
    });
  } catch (e: any) {
    console.error('admin market-detail error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
