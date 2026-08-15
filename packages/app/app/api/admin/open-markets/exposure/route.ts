import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/open-markets/exposure
//
// The daily number. An LMSR market maker's maximum possible loss on a market
// is exactly b·ln(N) — bounded, known before opening, and NOT dependent on how
// the market trades. Summed across live markets, that's the house's committed
// worst case.
//
// It is reported against house_reserve deployable rather than in isolation,
// because that reserve is SHARED with the locked-odds and multiplier engines:
// exposure here shrinks what those two can accept. A dashboard that showed
// Open Markets alone would look healthy while starving the engines that
// actually carry the volume.
//
// Health rows come from scan_open_markets_health(), which re-derives every
// book from its trade log rather than trusting the current curve. That
// distinction matters: after an unwind, q no longer represents historical
// cash-in, and measuring against the live curve flags every partially-unwound
// healthy market as critical.

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [expRes, cfgRes, reserveRes, healthRes, marketsRes] = await Promise.all([
    supabaseAdmin.from('open_markets_exposure').select('*').maybeSingle(),
    supabaseAdmin.from('open_markets_config')
      .select('trading_enabled, disabled_reason, max_total_exposure_tngn, max_market_b_tngn, allowed_categories')
      .eq('id', 1).maybeSingle(),
    supabaseAdmin.from('reserve_health').select('*').maybeSingle(),
    supabaseAdmin.rpc('scan_open_markets_health'),
    supabaseAdmin.from('open_markets')
      .select('id, question, category, outcomes, b, q, status, horizon_at, ' +
              'trading_closes_at, threshold_tngn, fees_collected, fees_collected_real, ' +
              'fees_swept, creator_accrued, creator_paid, created_by, opened_at, ' +
              'halted_reason, payout_phase, settlement_locked_until')
      .in('status', ['open', 'horizon_window', 'halted', 'closed', 'pending_payout'])
      .order('opened_at', { ascending: false, nullsFirst: false }),
  ]);

  if (expRes.error) return NextResponse.json({ error: expRes.error.message }, { status: 500 });

  const exp: any = expRes.data || {};
  const cfg: any = cfgRes.data || {};
  const reserve: any = reserveRes.data || {};

  const committed = Number(exp.worst_case_tngn || 0);
  const cap = Number(cfg.max_total_exposure_tngn || 0);
  const deployable = Number(reserve.deployable_tngn ?? reserve.deployable ?? 0);

  const markets = ((marketsRes.data || []) as any[]).map(m => {
    const n = Array.isArray(m.outcomes) ? m.outcomes.length : 2;
    const b = Number(m.b || 0);
    const worstCase = b * Math.log(Math.max(n, 2));
    const fees = Number(m.fees_collected || 0);
    const threshold = Number(m.threshold_tngn || 0);
    return {
      id: m.id,
      question: m.question,
      category: m.category,
      outcomeCount: n,
      status: m.status,
      bTngn: b,
      // The most the house can lose on this one market, full stop.
      worstCaseTngn: worstCase,
      feesCollectedTngn: fees,
      // Fees the trade path recorded but the sweep cron hasn't moved into the
      // reserve yet. A number that stops falling means the cron is dead.
      feesUnsweptTngn: fees - Number(m.fees_swept || 0),
      // Creator earns nothing until house fees exceed b·ln(N) — the house
      // recovers its entire maximum exposure before a naira is shared.
      thresholdTngn: threshold,
      thresholdProgress: threshold > 0 ? Math.min(1, fees / threshold) : 1,
      // Net of everything: fees taken in against the worst case still on risk.
      netIfWorstCaseTngn: fees - worstCase,
      creatorOwedTngn: Number(m.creator_accrued || 0) - Number(m.creator_paid || 0),
      horizonAt: m.horizon_at,
      tradingClosesAt: m.trading_closes_at,
      payoutPhase: m.payout_phase,
      settlementLockedUntil: m.settlement_locked_until,
      haltedReason: m.halted_reason,
      isHouse: !m.created_by,
      openedAt: m.opened_at,
    };
  });

  return NextResponse.json({
    tradingEnabled: cfg.trading_enabled !== false,
    disabledReason: cfg.disabled_reason || null,
    allowedCategories: cfg.allowed_categories || [],
    totals: {
      committedTngn: committed,
      capTngn: cap,
      headroomTngn: Math.max(0, cap - committed),
      capUsedPct: cap > 0 ? committed / cap : 0,
      // The cross-engine number. Above ~0.6 the health scan starts warning;
      // above 0.8 it goes critical, because the same pot backs place_bet_locked
      // and place_multiplier_slip.
      deployableTngn: deployable,
      reserveUsedPct: deployable > 0 ? committed / deployable : 0,
      feesCollectedTngn: Number(exp.fees_collected_tngn || 0),
      feesUnsweptTngn: Number(exp.fees_unswept_tngn || 0),
      creatorOwedTngn: Number(exp.creator_owed_tngn || 0),
      liveMarkets: Number(exp.live_markets || 0),
    },
    health: healthRes.error
      ? [{ severity: 'critical', check_name: 'health_scan_failed', detail: healthRes.error.message }]
      : (healthRes.data || []),
    markets,
  }, { headers: { 'Cache-Control': 'no-store' } });
}


// POST /api/admin/open-markets/exposure — the levers that live next to the
// numbers, because a dashboard that shows a problem and can't act on it sends
// the admin hunting for a psql prompt during an incident.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = String(body?.action || '');

  switch (action) {
    // Engine-wide kill switch. Blocks new trades and new approvals; does NOT
    // touch existing positions, which stay exitable — freezing people's money
    // is a bigger incident than whatever prompted the pause.
    case 'pause':
    case 'resume': {
      const { error } = await supabaseAdmin
        .from('open_markets_config')
        .update({
          trading_enabled: action === 'resume',
          disabled_reason: action === 'pause' ? (String(body?.reason || '').trim() || 'paused by admin') : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ tradingEnabled: action === 'resume' });
    }

    // Single market. Halt preserves the status it was halted FROM, so halting
    // during a horizon window doesn't silently drop the market back to plain
    // trading and strand every cash-out election.
    case 'halt': {
      const { data, error } = await supabaseAdmin.rpc('halt_open_market', {
        p_market_id: String(body?.marketId || ''),
        p_admin_id: body?.adminId || process.env.ADMIN_REVIEWER_USER_ID || null,
        p_reason: String(body?.reason || '').trim() || 'halted by admin',
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ result: Array.isArray(data) ? data[0] : data });
    }
    case 'resume_market': {
      const { data, error } = await supabaseAdmin.rpc('resume_open_market', {
        p_market_id: String(body?.marketId || ''),
        p_admin_id: body?.adminId || process.env.ADMIN_REVIEWER_USER_ID || null,
        p_to_status: String(body?.toStatus || 'open'),
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ result: Array.isArray(data) ? data[0] : data });
    }

    // Moves recorded fees into house_reserve. The trade path deliberately does
    // not touch the reserve — it would serialise every trade on one row, and
    // it deadlocked against settle_multiplier_market — so this reconciles.
    case 'sweep_fees': {
      const { data, error } = await supabaseAdmin.rpc('sweep_open_market_fees');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const row = Array.isArray(data) ? data[0] : data;
      return NextResponse.json({
        marketsSwept: Number(row?.markets_swept || 0),
        tngnSwept: Number(row?.tngn_swept || 0),
      });
    }

    case 'set_cap': {
      const cap = Number(body?.maxTotalExposureTngn);
      if (!Number.isFinite(cap) || cap < 0) {
        return NextResponse.json({ error: 'Cap must be a positive number' }, { status: 400 });
      }
      const { error } = await supabaseAdmin
        .from('open_markets_config')
        .update({ max_total_exposure_tngn: cap, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ maxTotalExposureTngn: cap });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
