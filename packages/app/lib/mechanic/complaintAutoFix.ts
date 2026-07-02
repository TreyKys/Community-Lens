import type { SupabaseClient } from '@supabase/supabase-js';
import { runFixForFinding } from './fixers';
import type { Finding } from './types';

// Given a triaged complaint, look for the specific fixable pattern
// affecting THIS user and try to auto-resolve. Returns a summary of
// what happened.
//
// This is intentionally per-user (not a global scan) so a bug in the
// scanner can't cascade into every open slip while responding to one
// complaint. The finding is constructed here from a targeted query
// rather than pulled from a scan.

export interface AutoFixResult {
  attempted: boolean;
  applied: boolean;
  outcomeStatus: 'fixed' | 'not_applicable' | 'not_yet_detectable' | 'error';
  detail: string;
  findings?: Finding[];
}

// Only categories with a deterministic, per-user fixable pattern get an
// auto-fix attempt. Everything else queues to admin for review — same
// pattern as the Mechanic dispatcher.
export async function attemptComplaintAutoFix(
  db: SupabaseClient,
  input: {
    userId: string;
    triageCategory: string;
    relatedBetId?: string | null;
    relatedSlipId?: string | null;
  },
): Promise<AutoFixResult> {
  const { userId, triageCategory, relatedSlipId } = input;

  // ── Slip stuck ────────────────────────────────────────────────────
  if (triageCategory === 'slip_stuck') {
    // Look for THIS user's slips that are status='active' but have
    // zero active legs (the finalize_stalled_slip fingerprint), scoped
    // to a specific slip if the user pointed at one.
    let query = db
      .from('multiplier_slips')
      .select('id, status, legs_total')
      .eq('user_id', userId)
      .eq('status', 'active');
    if (relatedSlipId) query = query.eq('id', relatedSlipId);
    const { data: activeSlips } = await query.limit(20);
    if (!activeSlips || activeSlips.length === 0) {
      return { attempted: false, applied: false, outcomeStatus: 'not_applicable', detail: 'No active slips found for this user.' };
    }
    const ids = activeSlips.map(s => s.id);
    const { data: legs } = await db.from('multiplier_legs').select('slip_id, status').in('slip_id', ids);
    const byId: Record<string, string[]> = {};
    for (const l of legs || []) (byId[l.slip_id] ||= []).push(l.status);
    const stalled = activeSlips.filter(s => {
      const st = byId[s.id] || [];
      return st.length > 0 && st.every(x => x !== 'active');
    });
    if (stalled.length === 0) {
      return { attempted: false, applied: false, outcomeStatus: 'not_yet_detectable', detail: 'Slip still has active legs waiting on market resolution — not stuck at the slip level.' };
    }
    // One finding per stalled slip, run each through the dispatcher.
    const findings: Finding[] = stalled.map(s => ({
      fingerprint: `stuck_slip:${s.id}`,
      category: 'settlement',
      issueType: 'stuck_slip',
      severity: 'warning',
      tier: 'approval_required',
      title: `Slip stuck at 'active' — all legs already settled`,
      detail: 'Auto-fix from user complaint.',
      affectedIds: { slipId: s.id, userId },
    }));
    let applied = 0;
    for (const f of findings) {
      const out = await runFixForFinding(db, f, { dryRun: false, operator: 'mechanic:complaint_auto_fix' });
      if (out.ok && out.applied) applied += 1;
    }
    return {
      attempted: true,
      applied: applied > 0,
      outcomeStatus: applied > 0 ? 'fixed' : 'error',
      detail: `Attempted to finalize ${findings.length} stalled slip(s); ${applied} succeeded.`,
      findings,
    };
  }

  // ── Bet stuck (single) ────────────────────────────────────────────
  // A stuck single is almost always downstream of a stuck-resolution
  // fingerprint on its market — auto-fix by running the market's
  // resume through repair-stuck-resolutions if applicable.
  if (triageCategory === 'bet_stuck') {
    const { data: bets } = await db
      .from('user_bets')
      .select('id, market_id, status, markets:market_id (id, status, resolved_outcome, resolved_outcomes)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(20);
    const stuckMarkets = (bets || [])
      .map(b => (b.markets as any))
      .filter(m => m && m.status === 'locked' && (m.resolved_outcome !== null && m.resolved_outcome !== undefined));
    if (stuckMarkets.length === 0) {
      return {
        attempted: false, applied: false, outcomeStatus: 'not_yet_detectable',
        detail: 'No active bets on a stuck-resolution market found. Queueing for admin review.',
      };
    }
    const uniqIds = Array.from(new Set(stuckMarkets.map((m: any) => m.id)));
    const findings: Finding[] = uniqIds.map((mid: any) => ({
      fingerprint: `stuck_resolution:${mid}`,
      category: 'settlement',
      issueType: 'stuck_resolution',
      severity: 'critical',
      tier: 'approval_required',
      title: `Market #${mid} claimed but never finalized`,
      detail: 'Auto-fix from user complaint.',
      affectedIds: { marketId: mid },
    }));
    let applied = 0;
    for (const f of findings) {
      const out = await runFixForFinding(db, f, { dryRun: false, operator: 'mechanic:complaint_auto_fix' });
      if (out.ok && out.applied) applied += 1;
    }
    return {
      attempted: true,
      applied: applied > 0,
      outcomeStatus: applied > 0 ? 'fixed' : 'error',
      detail: `Attempted to resume ${uniqIds.length} stuck market resolution(s); ${applied} succeeded.`,
      findings,
    };
  }

  // ── Everything else: queue for admin ───────────────────────────────
  // Deposits/withdrawals/balance require gateway/ledger investigation
  // beyond what per-user scans safely handle. Queue to Monitor.
  return { attempted: false, applied: false, outcomeStatus: 'not_applicable', detail: 'Queued for admin review.' };
}
