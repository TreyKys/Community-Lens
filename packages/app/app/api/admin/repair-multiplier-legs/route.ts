import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/repair-multiplier-legs
//
// Settles Multiplier legs that were orphaned by the old resolve logic.
// Until this fix, settle_multiplier_for_market only fired inside the
// locked-odds resolve branch — so a leg whose market resolved through
// the parimutuel path stayed 'active' forever, and the parent slip
// never advanced (the user saw "still active" days after the markets
// resolved).
//
// This finds every market that (a) is already resolved or voided and
// (b) still has active legs riding on it, then re-runs
// settle_multiplier_for_market for each. The RPC only touches
// status='active' legs and active slips, so it's idempotent and safe to
// run repeatedly — already-settled legs and slips are untouched.
//
// dryRun defaults TRUE: lists the markets + leg counts that WOULD be
// settled without changing anything. Re-POST { dryRun: false } to apply.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const dryRun = body?.dryRun !== false; // default TRUE

  // 1. Every market that still has active legs on it.
  const { data: activeLegs, error: legErr } = await supabaseAdmin
    .from('multiplier_legs')
    .select('market_id')
    .eq('status', 'active');
  if (legErr) return NextResponse.json({ error: legErr.message }, { status: 500 });

  const marketIds = Array.from(new Set((activeLegs || []).map((l: any) => Number(l.market_id))));
  if (marketIds.length === 0) {
    return NextResponse.json({ dryRun, marketsToRepair: 0, repaired: [], note: 'No active legs anywhere — nothing to repair.' });
  }

  // 2. Of those, which markets have ALREADY resolved/voided? Those are
  //    the orphans — their legs should have settled at resolution time.
  const { data: markets, error: mErr } = await supabaseAdmin
    .from('markets')
    .select('id, question, status, resolved_outcome')
    .in('id', marketIds)
    .in('status', ['resolved', 'voided']);
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  const repaired: any[] = [];
  let totalLegsSettled = 0;

  for (const m of markets || []) {
    // Count the active legs on this market for the report.
    const { count } = await supabaseAdmin
      .from('multiplier_legs')
      .select('id', { count: 'exact', head: true })
      .eq('market_id', m.id)
      .eq('status', 'active');

    const legCount = count ?? 0;
    // A market is treated as voided for leg purposes when its status is
    // 'voided' OR it has no determinable winning outcome. Otherwise the
    // resolved_outcome is the winning index.
    const isVoided = m.status === 'voided' || m.resolved_outcome === null || m.resolved_outcome === undefined;

    const entry = {
      marketId: m.id,
      question: m.question,
      status: m.status,
      resolvedOutcome: m.resolved_outcome,
      settledAs: isVoided ? 'voided' : `outcome ${m.resolved_outcome}`,
      activeLegs: legCount,
    };

    if (!dryRun) {
      try {
        const { data: processed } = await supabaseAdmin.rpc('settle_multiplier_for_market', {
          p_market_id: m.id,
          p_winning_outcome: isVoided ? null : m.resolved_outcome,
          p_voided: isVoided,
        });
        (entry as any).legsProcessed = Number(processed ?? 0);
      } catch (e: any) {
        (entry as any).error = e?.message || 'settle failed';
      }
    }

    repaired.push(entry);
    totalLegsSettled += legCount;
  }

  return NextResponse.json({
    dryRun,
    marketsToRepair: repaired.length,
    totalOrphanedLegs: totalLegsSettled,
    repaired,
    note: dryRun
      ? 'DRY RUN — nothing changed. Re-POST { dryRun: false } to settle these legs. The RPC is idempotent (only active legs/slips are touched), so applying is safe to repeat.'
      : 'Applied. Orphaned legs settled; any slip whose final leg just resolved has been paid/marked and notified by the settlement RPC.',
  });
}
