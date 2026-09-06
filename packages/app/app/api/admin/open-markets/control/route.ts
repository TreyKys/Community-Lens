import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getAuthUser } from '@/lib/getAuthUser';
import { pricesFromQ, volumeFromFees } from '@/lib/openMarketTypes';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET/POST /api/admin/open-markets/control
//
// The one place that sees EVERY Open Markets row regardless of status —
// every other admin screen deliberately narrows to the slice it needs
// (the review queue to pending_review/revise, resolve to what's awaiting a
// decision, exposure to what's live). This is the "where is everything"
// view: the full list, plus the two controls that never had a home anywhere
// — deleting a market outright, and rescheduling one that's already open —
// alongside the category allowlist. Halting, pausing the engine, solo mode
// and fee sweeps stay owned by /api/admin/open-markets/exposure; this page
// calls that same endpoint for those rather than re-implementing them.

const ALL_STATUSES = [
  'pending_review', 'revise', 'rejected',
  'open', 'horizon_window', 'halted', 'closed',
  'pending_payout', 'resolved', 'voided', 'retired',
];

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status'); // one of ALL_STATUSES, or 'all'
  const q = (searchParams.get('q') || '').trim().toLowerCase();

  let query = supabaseAdmin
    .from('open_markets')
    .select('id, question, description, category, outcomes, q, q_initial, b, status, ' +
            'resolution_source, trading_closes_at, horizon_at, resolved_outcome, ' +
            'fees_collected, fees_swept, threshold_tngn, creator_accrued, creator_paid, ' +
            'created_by, submitted_by, event_tag, opened_at, resolved_at, created_at, ' +
            'halted_reason, self_reviewed, self_resolved')
    .order('created_at', { ascending: false })
    .limit(500);

  if (status && status !== 'all' && ALL_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  const [marketsRes, cfgRes, countsRes] = await Promise.all([
    query,
    supabaseAdmin.from('open_markets_config')
      .select('trading_enabled, disabled_reason, max_total_exposure_tngn, max_market_b_tngn, allowed_categories, solo_operator_mode, solo_operator_set_at')
      .eq('id', 1).maybeSingle(),
    // Status counts across the WHOLE table, unfiltered — powers the filter
    // tabs' badges regardless of which one is currently selected.
    supabaseAdmin.from('open_markets').select('status'),
  ]);

  if (marketsRes.error) return NextResponse.json({ error: marketsRes.error.message }, { status: 500 });

  let rows = (marketsRes.data || []) as any[];
  if (q) rows = rows.filter(m => String(m.question || '').toLowerCase().includes(q));

  const ids = rows.map(m => m.id);

  // Activity, per market — this is what decides whether Delete is even
  // offered. A market with one row in open_trades is never a delete
  // candidate (the RPC would refuse it anyway; this just saves the round
  // trip and stops the button from ever promising something it can't do).
  const activeIds = new Set<string>();
  const holderCounts: Record<string, number> = {};
  if (ids.length) {
    const { data: trades } = await supabaseAdmin
      .from('open_trades').select('market_id').in('market_id', ids);
    for (const t of (trades || []) as any[]) activeIds.add(t.market_id);

    const { data: positions } = await supabaseAdmin
      .from('open_positions').select('market_id')
      .in('market_id', ids).eq('status', 'open').gt('shares_cash', 0);
    for (const p of (positions || []) as any[]) {
      holderCounts[p.market_id] = (holderCounts[p.market_id] || 0) + 1;
    }
  }

  const cfg: any = cfgRes.data || {};
  const statusCounts: Record<string, number> = {};
  for (const r of (countsRes.data || []) as any[]) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  const markets = rows.map(m => {
    const n = Array.isArray(m.outcomes) ? m.outcomes.length : 2;
    const prices = pricesFromQ(m.q, m.b || 1);
    return {
      id: m.id,
      question: m.question,
      category: m.category,
      eventTag: m.event_tag,
      outcomes: m.outcomes,
      prices,
      status: m.status,
      resolutionSource: m.resolution_source,
      tradingClosesAt: m.trading_closes_at,
      horizonAt: m.horizon_at,
      resolvedOutcome: m.resolved_outcome,
      volumeTngn: volumeFromFees(m.fees_collected),
      feesCollectedTngn: Number(m.fees_collected || 0),
      feesUnsweptTngn: Number(m.fees_collected || 0) - Number(m.fees_swept || 0),
      thresholdTngn: Number(m.threshold_tngn || 0),
      creatorOwedTngn: Number(m.creator_accrued || 0) - Number(m.creator_paid || 0),
      isHouse: !m.created_by,
      submittedBy: m.submitted_by,
      haltedReason: m.halted_reason,
      selfReviewed: !!m.self_reviewed,
      selfResolved: !!m.self_resolved,
      openHolders: holderCounts[m.id] || 0,
      hasActivity: activeIds.has(m.id),
      createdAt: m.created_at,
      openedAt: m.opened_at,
      resolvedAt: m.resolved_at,
    };
  });

  return NextResponse.json({
    config: {
      tradingEnabled: cfg.trading_enabled !== false,
      disabledReason: cfg.disabled_reason || null,
      allowedCategories: cfg.allowed_categories || [],
      maxTotalExposureTngn: Number(cfg.max_total_exposure_tngn || 0),
      maxMarketBTngn: Number(cfg.max_market_b_tngn || 0),
      soloOperatorMode: !!cfg.solo_operator_mode,
      soloOperatorSetAt: cfg.solo_operator_set_at || null,
    },
    statusCounts,
    statuses: ALL_STATUSES,
    markets,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = String(body?.action || '');

  const sessionUser = await getAuthUser(supabaseAdmin, request);
  const adminId = sessionUser?.id
    || String(body?.adminId || '').trim()
    || process.env.ADMIN_REVIEWER_USER_ID
    || null;

  switch (action) {
    // Erases the row. Only ever succeeds on a market with no trade,
    // position or settlement ever recorded against it — enforced by the
    // database's own foreign keys, not by this route. See the migration
    // comment in 20260907000000 for why that split is deliberate.
    case 'delete': {
      const marketId = String(body?.marketId || '');
      const reason = String(body?.reason || '').trim();
      const { data, error } = await supabaseAdmin.rpc('admin_delete_open_market', {
        p_market_id: marketId,
        p_admin_id: adminId,
        p_reason: reason,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied) return NextResponse.json({ error: row?.reason || 'Could not delete' }, { status: 400 });
      return NextResponse.json({ deleted: true });
    }

    // Moves trading_closes_at / horizon_at on a market that's already open —
    // the one thing that was previously fixed the instant a market opened.
    case 'reschedule': {
      const marketId = String(body?.marketId || '');
      const tradingClosesAt = body?.tradingClosesAt || null;
      const horizonAt = body?.horizonAt || null;
      const { data, error } = await supabaseAdmin.rpc('admin_reschedule_open_market', {
        p_market_id: marketId,
        p_admin_id: adminId,
        p_trading_closes_at: tradingClosesAt,
        p_horizon_at: horizonAt,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied) return NextResponse.json({ error: row?.reason || 'Could not reschedule' }, { status: 400 });
      return NextResponse.json({ rescheduled: true });
    }

    // The category allowlist. Read everywhere submit_open_market and
    // review_open_market check it; written nowhere until now — every
    // category live today was added by hand in a migration.
    case 'set_allowed_categories': {
      const categories = Array.isArray(body?.categories)
        ? Array.from(new Set(body.categories.map((c: unknown) => String(c).trim().toLowerCase()).filter(Boolean)))
        : null;
      if (!categories || categories.length === 0) {
        return NextResponse.json({ error: 'Need at least one category' }, { status: 400 });
      }
      const { error } = await supabaseAdmin
        .from('open_markets_config')
        .update({ allowed_categories: categories, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ allowedCategories: categories });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
