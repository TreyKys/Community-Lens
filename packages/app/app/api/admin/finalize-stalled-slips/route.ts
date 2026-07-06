import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/finalize-stalled-slips
//
// Finds every Multiplier slip that's status='active' but has ZERO
// active legs remaining (every leg already shows won/lost/void) — the
// exact fingerprint /api/admin/inspect-slip flags as
// allLegsSettledButSlipStillActive — and finalizes each one via the
// finalize_stalled_slip() RPC. This is the case neither
// repair-multiplier-legs nor a resolve() resume can touch, because both
// only act on legs that are still 'active'; when every leg is already
// final, there's nothing left for either of them to find.
//
// dryRun defaults TRUE: lists the slips that would be finalized (and
// what each leg currently shows) without changing anything. Re-POST
// { dryRun: false } to apply. Idempotent — finalize_stalled_slip()
// no-ops on a slip that's no longer 'active', so safe to re-run.
//
// Body: { slipIds?: string[], dryRun?: boolean }
//   - slipIds: scope to specific slips (recommended once you've
//     reviewed them via inspect-slip). Omit to scan every stalled slip
//     system-wide.
export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: any = {};
    try { body = await request.json(); } catch { /* empty body ok */ }
    const dryRun = body?.dryRun !== false;
    const explicitSlipIds: string[] | null = Array.isArray(body?.slipIds) && body.slipIds.length > 0
      ? body.slipIds
      : null;

    let slipQuery = supabaseAdmin
      .from('multiplier_slips')
      .select('id, user_id, status, legs_total, legs_resolved, net_slip_stake_tngn')
      .eq('status', 'active');
    if (explicitSlipIds) slipQuery = slipQuery.in('id', explicitSlipIds);
    const { data: activeSlips, error: sErr } = await slipQuery.limit(500);
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });

    if (!activeSlips || activeSlips.length === 0) {
      return NextResponse.json({ dryRun, slipsScanned: 0, stalled: [], note: 'No active slips found in scope.' });
    }

    const slipIds = activeSlips.map(s => s.id);
    const { data: legs, error: lErr } = await supabaseAdmin
      .from('multiplier_legs')
      .select('slip_id, status')
      .in('slip_id', slipIds);
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

    const legsBySlip: Record<string, string[]> = {};
    for (const l of legs || []) {
      (legsBySlip[l.slip_id] ||= []).push(l.status);
    }

    // Stalled = every leg on the slip is already final (none 'active').
    const stalledSlips = activeSlips.filter(s => {
      const statuses = legsBySlip[s.id] || [];
      return statuses.length > 0 && statuses.every(st => st !== 'active');
    });

    if (stalledSlips.length === 0) {
      return NextResponse.json({
        dryRun, slipsScanned: activeSlips.length, stalled: [],
        note: 'No stalled slips found — every active slip in scope still has at least one active leg (genuinely waiting on a market to resolve), which is expected, not a bug.',
      });
    }

    const results: any[] = [];
    for (const s of stalledSlips) {
      const entry: any = {
        slipId: s.id,
        userId: s.user_id,
        legsTotal: s.legs_total,
        legsResolvedBefore: s.legs_resolved,
        legStatuses: legsBySlip[s.id],
      };
      if (!dryRun) {
        const { data, error } = await supabaseAdmin.rpc('finalize_stalled_slip', { p_slip_id: s.id }).single<{ applied: boolean; new_status: string; payout_tngn: number }>();
        if (error) {
          entry.error = error.message;
        } else {
          entry.applied = data?.applied;
          entry.newStatus = data?.new_status;
          entry.payoutTngn = data?.payout_tngn;
        }
      }
      results.push(entry);
    }

    return NextResponse.json({
      dryRun,
      slipsScanned: activeSlips.length,
      stalledCount: stalledSlips.length,
      stalled: results,
      note: dryRun
        ? 'DRY RUN — nothing changed. Re-POST { dryRun: false } to finalize these slips (pays winners, applies house P&L, sends notifications, refunds all-void slips including their Boost).'
        : 'Applied. Each slip finalized via finalize_stalled_slip() — check newStatus/payoutTngn per slip. Idempotent; safe to re-run if any entry shows an error.',
    });
  } catch (e: any) {
    console.error('finalize-stalled-slips crashed:', e);
    return NextResponse.json({ error: `Finalize failed: ${e?.message || String(e)}` }, { status: 500 });
  }
}
