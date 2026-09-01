import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getAuthUser } from '@/lib/getAuthUser';
import { pricesFromQ } from '@/lib/openMarketTypes';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Open Markets resolution.
//
// The approval gate opens books; this closes them. Without it markets trade,
// hit their cut-off, and then sit in 'closed' forever with everyone's money
// inside — the engine had no path from "trading finished" to "holders paid".
//
// Four eyes are mandatory and enforced in settle_open_market, not here: the
// resolver and the confirmer must be two different people and neither may be
// the market's creator. Resolution is the single point where an admin decides
// who gets paid, so one person must never be able to do it alone.
//
// Every destructive action defaults to a dry run. The preview reports what
// WOULD be paid, from the same code path that pays it — not a re-implementation
// that could disagree with the real thing.

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Everything that needs a human decision, plus what is mid-payout so a
  // stalled release is visible rather than silently stuck.
  const { data, error } = await supabaseAdmin
    .from('open_markets')
    .select('id, question, category, outcomes, q, b, status, resolution_source, ' +
            'resolution_detail, resolved_outcome, resolved_by, resolution_confirmed_by, ' +
            'resolution_evidence_url, trading_closes_at, horizon_at, horizon_count, ' +
            'dispute_window_hours, settlement_locked_until, payout_phase, pending_kind, ' +
            'created_by, halted_reason, max_hold_until, opened_at, self_reviewed')
    .in('status', ['open', 'closed', 'halted', 'pending_payout', 'horizon_window'])
    .order('trading_closes_at', { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (data || []).map((m: any) => m.id);
  const holders: Record<string, { positions: number; shares: number }> = {};
  if (ids.length) {
    const { data: pos } = await supabaseAdmin
      .from('open_positions')
      .select('market_id, shares_cash, shares_bonus')
      .in('market_id', ids)
      .eq('status', 'open');
    for (const p of (pos || []) as any[]) {
      const h = (holders[p.market_id] ||= { positions: 0, shares: 0 });
      const s = Number(p.shares_cash || 0) + Number(p.shares_bonus || 0);
      if (s > 0) { h.positions++; h.shares += s; }
    }
  }

  // Unreleased settlement rows: a market that computed but never paid out is
  // the exact failure the two-phase design can produce if the cron dies.
  const unreleased: Record<string, number> = {};
  if (ids.length) {
    const { data: s } = await supabaseAdmin
      .from('open_settlements')
      .select('market_id')
      .in('market_id', ids)
      .is('released_at', null);
    for (const row of (s || []) as any[]) {
      unreleased[row.market_id] = (unreleased[row.market_id] || 0) + 1;
    }
  }

  const now = Date.now();
  const markets = (data || []).map((m: any) => {
    const closesAt = m.trading_closes_at ? new Date(m.trading_closes_at).getTime() : null;
    return {
      id: m.id,
      question: m.question,
      category: m.category,
      outcomes: m.outcomes,
      prices: pricesFromQ(m.q, m.b),
      status: m.status,
      resolutionSource: m.resolution_source,
      resolutionDetail: m.resolution_detail,
      resolvedOutcome: m.resolved_outcome,
      resolvedBy: m.resolved_by,
      confirmedBy: m.resolution_confirmed_by,
      evidenceUrl: m.resolution_evidence_url,
      tradingClosesAt: m.trading_closes_at,
      horizonAt: m.horizon_at,
      horizonCount: m.horizon_count,
      disputeWindowHours: m.dispute_window_hours,
      settlementLockedUntil: m.settlement_locked_until,
      payoutPhase: m.payout_phase,
      pendingKind: m.pending_kind,
      haltedReason: m.halted_reason,
      isHouse: !m.created_by,
      selfReviewed: !!m.self_reviewed,
      createdBy: m.created_by,
      openHolders: holders[m.id]?.positions || 0,
      openShares: holders[m.id]?.shares || 0,
      unreleasedRows: unreleased[m.id] || 0,
      // Trading is over but nobody has resolved it — this is the queue that
      // actually needs attention.
      awaitingResolution: m.status === 'closed'
        || (m.status === 'open' && closesAt !== null && closesAt <= now),
      // The book is still live while its cut-off has passed: the house is the
      // counterparty to every informed trade until someone closes it.
      overdueClose: m.status === 'open' && closesAt !== null && closesAt <= now,
      releaseUnlocked: !m.settlement_locked_until
        || new Date(m.settlement_locked_until).getTime() <= now,
    };
  });

  return NextResponse.json({ markets }, { headers: { 'Cache-Control': 'no-store' } });
}


export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const action = String(body?.action || '');
  const marketId = String(body?.marketId || '');
  if (!marketId) return NextResponse.json({ error: 'Missing marketId' }, { status: 400 });

  const sessionUser = await getAuthUser(supabaseAdmin, request);
  const resolvedBy = sessionUser?.id
    || String(body?.resolvedBy || '')
    || process.env.ADMIN_REVIEWER_USER_ID
    || '';

  switch (action) {
    // Trading stops here. Separate from resolving on purpose: settlement must
    // not be reachable while the book is still live, or an admin can resolve
    // a market that traders are filling against a known answer.
    case 'close_trading': {
      const { error } = await supabaseAdmin
        .from('open_markets')
        .update({ status: 'closed' })
        .eq('id', marketId)
        .eq('status', 'open');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ status: 'closed' });
    }

    case 'settle': {
      const outcomeIdx = Number(body?.outcomeIdx);
      if (!Number.isInteger(outcomeIdx) || outcomeIdx < 0) {
        return NextResponse.json({ error: 'Choose the winning outcome' }, { status: 400 });
      }
      const confirmedBy = String(body?.confirmedBy || '').trim();
      if (!resolvedBy || !confirmedBy) {
        return NextResponse.json({
          error: 'Resolution needs two people: a resolver and a confirmer.',
        }, { status: 400 });
      }
      const evidence = String(body?.evidenceUrl || '').trim();
      // Evidence is what makes a dispute answerable months later. A resolution
      // with no link is one admin's memory against a user's.
      if (!body?.dryRun && !evidence) {
        return NextResponse.json({ error: 'Link the evidence for this outcome' }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin.rpc('settle_open_market', {
        p_market_id: marketId,
        p_outcome_idx: outcomeIdx,
        p_resolved_by: resolvedBy,
        p_confirmed_by: confirmedBy,
        p_evidence_url: evidence || null,
        p_dry_run: body?.dryRun !== false,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      // A dry run deliberately reports applied=false with reason 'dry_run';
      // that is a successful preview, not a refusal.
      if (!row?.applied && row?.reason !== 'dry_run') {
        return NextResponse.json({ error: row?.reason || 'Could not settle' }, { status: 400 });
      }
      return NextResponse.json({
        preview: row?.reason === 'dry_run',
        positions: Number(row?.positions || 0),
        winners: Number(row?.winners || 0),
        grossTngn: Number(row?.gross_tngn || 0),
        housePnlTngn: Number(row?.house_pnl || 0),
        lockedUntil: row?.locked_until || null,
      });
    }

    // Void returns money instead of picking a winner. Used when the question
    // became unanswerable, or when the house got something wrong.
    case 'void': {
      const confirmedBy = String(body?.confirmedBy || '').trim();
      if (!resolvedBy || !confirmedBy) {
        return NextResponse.json({
          error: 'Voiding needs two people: a requester and an approver.',
        }, { status: 400 });
      }
      const kind = String(body?.kind || 'operational');
      // cost_basis refunds what people paid; pro_rata splits the book at its
      // last prices. house_fault pairs with cost_basis because if the mistake
      // is ours, nobody should lose money to it.
      const basis = String(body?.basis || (kind === 'house_fault' ? 'cost_basis' : 'pro_rata'));
      const reason = String(body?.reason || '').trim();
      if (!body?.dryRun && reason.length < 10) {
        return NextResponse.json({ error: 'Say why this is being voided' }, { status: 400 });
      }

      const { data, error } = await supabaseAdmin.rpc('void_open_market', {
        p_market_id: marketId,
        p_kind: kind,
        p_basis: basis,
        p_requested_by: resolvedBy,
        p_approved_by: confirmedBy,
        p_reason: reason || null,
        p_dry_run: body?.dryRun !== false,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied && row?.reason !== 'dry_run') {
        return NextResponse.json({ error: row?.reason || 'Could not void' }, { status: 400 });
      }
      return NextResponse.json({
        preview: row?.reason === 'dry_run',
        positions: Number(row?.positions || 0),
        poolTngn: Number(row?.pool_tngn || 0),
        grossTngn: Number(row?.gross_tngn || 0),
        houseTopupTngn: Number(row?.house_topup_tngn || 0),
        lockedUntil: row?.locked_until || null,
      });
    }

    // Manual release. The cron does this automatically; this is for when a
    // payout is stuck and someone needs to push it through by hand.
    case 'release': {
      try {
        const { data, error } = await supabaseAdmin.rpc('release_open_settlements', {
          p_market_id: marketId,
          p_limit: 250,
          p_force: body?.force === true,
        });
        if (error) throw new Error(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        return NextResponse.json({
          released: Number(row?.released || 0),
          failed: Number(row?.failed || 0),
          remaining: Number(row?.remaining || 0),
          finished: !!row?.finished,
        });
      } catch (e: any) {
        // Halted, disputed, inside the dispute window, or already finished —
        // all of these raise, and all are things the admin needs to read.
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
