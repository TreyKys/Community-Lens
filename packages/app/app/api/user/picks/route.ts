import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// No caching AT ALL on this endpoint — this is the direct-from-DB
// truth-source the bets page relies on to show correct settlement
// status after a slip resolves. Any stale response here is exactly the
// "UI stuck showing old status" symptom.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function getAuthUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// GET /api/user/picks — single bets + multiplier slips for the current user
//
// Server-side, service-role read. This exists specifically because the
// original client-side query on the bets page (supabase-js against RLS
// on multiplier_slips and multiplier_legs) was silently returning stale
// data after manual DB corrections — either because of an edge cache,
// a connection-pool replica lag, or RLS quietly filtering something the
// join needs. Going through service_role from a fresh server invocation
// with force-no-store bypasses every one of those failure modes and
// puts the raw DB truth on the wire.
export async function GET(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const [betsRes, slipsRes] = await Promise.all([
      supabaseAdmin
        .from('user_bets')
        .select(`
          id, market_id, outcome_index, stake_tngn, net_stake_tngn, payout_tngn,
          is_jackpot_eligible, is_first_bet_refunded, status, placed_at,
          markets:market_id (id, title, question, options, status, closes_at, merkle_root, total_pool, pool_by_outcome)
        `)
        .eq('user_id', user.id)
        .order('placed_at', { ascending: false })
        .limit(200),
      supabaseAdmin
        .from('multiplier_slips')
        .select(`
          id, slip_stake_tngn, net_slip_stake_tngn, combined_odds,
          effective_combined_odds, payout_tngn, final_payout_tngn,
          legs_total, legs_resolved, legs_won, status, created_at, settled_at,
          multiplier_legs (
            id, market_id, outcome_index, locked_odds, realized_odds, status,
            markets:market_id (id, title, question, options, status, closes_at, resolved_outcome, resolved_outcomes)
          )
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    if (betsRes.error) return NextResponse.json({ error: betsRes.error.message }, { status: 500 });
    if (slipsRes.error) return NextResponse.json({ error: slipsRes.error.message }, { status: 500 });

    return NextResponse.json({
      bets: betsRes.data || [],
      slips: slipsRes.data || [],
      // The bets page checks this to know it's talking to the fresh
      // endpoint and not some cached response. Also lets a support
      // engineer confirm from a HAR file that the client is on the new
      // path.
      _source: 'server_direct',
      _fetchedAt: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Surrogate-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
