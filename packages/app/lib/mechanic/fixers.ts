import type { SupabaseClient } from '@supabase/supabase-js';
import type { Finding, CascadeTier } from './types';
import { getBaseUrl } from '@/lib/oracle';

// The fix dispatcher. Every fixer is a small wrapper around an existing
// admin repair endpoint — this file adds nothing new to the fix logic,
// it just centralizes the "given a finding, run its fix" mapping so
// /ops buttons and the cron heartbeat share one code path.
//
// The design lets us:
//   * dryRun a fix and get back a plan without applying it
//     (preview-before-apply on money-touching ops)
//   * record a mechanic_log row with the reverse operation for undo
//     (where the underlying endpoint supports it)
//   * classify auto vs approval consistently — the finding already
//     carries its cascade tier

export interface FixOutcome {
  ok: boolean;
  planned?: boolean;              // dry run
  applied?: boolean;              // wet run
  summary: string;                // human-readable
  details: any;                   // whatever the endpoint returned
  deltaTngn?: number;
  affectedUserIds?: string[];
  reverseOp?: any;                // stored on mechanic_log for Undo
  httpStatus?: number;
}

const NO_UNDO = null;

// Every repair endpoint this dispatcher calls (reconcile-void-losses,
// repair-multiplier-legs, repair-stuck-resolutions, finalize-stalled-
// slips, re-resolve-voided-market) gates on isAdminRequest(), which
// only accepts an `Authorization: Bearer <ADMIN_SECRET>` header or the
// admin cookie — NOT the x-cron-secret header /api/markets/resolve and
// /api/markets/lock also happen to accept. Mechanic runs server-side
// with no browser cookie to forward, so Bearer ADMIN_SECRET is the one
// header that authenticates against every endpoint in the dispatch
// table uniformly. (This was the literal cause of "fixes aren't
// working" — every dispatched call was silently 401ing.)
function adminServiceHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.ADMIN_SECRET}`,
  };
}

async function callEndpoint(endpoint: string, body: any): Promise<{ status: number; body: any }> {
  const baseUrl = getBaseUrl();
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: adminServiceHeaders(),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ── per-issue fixers ────────────────────────────────────────────────

async function fixStuckSlip(_db: SupabaseClient, finding: Finding, dryRun: boolean): Promise<FixOutcome> {
  const slipId = finding.affectedIds.slipId!;
  const { status, body } = await callEndpoint('/api/admin/finalize-stalled-slips', { slipIds: [slipId], dryRun });
  const stalledEntry = body?.stalled?.[0];
  return {
    ok: status < 400,
    planned: dryRun,
    applied: !dryRun && status < 400,
    summary: dryRun
      ? `Would finalize slip ${slipId.slice(0, 8)}… (legs: ${(stalledEntry?.legStatuses || []).join(', ')})`
      : `Slip ${slipId.slice(0, 8)}… finalized as ${stalledEntry?.newStatus ?? 'unknown'} (payout ₦${Math.round(stalledEntry?.payoutTngn || 0).toLocaleString()})`,
    details: body,
    deltaTngn: Number(stalledEntry?.payoutTngn || 0),
    reverseOp: NO_UNDO,           // finalize_stalled_slip is not cleanly reversible
    httpStatus: status,
  };
}

async function fixOrphanedLegs(_db: SupabaseClient, _finding: Finding, dryRun: boolean): Promise<FixOutcome> {
  const { status, body } = await callEndpoint('/api/admin/repair-multiplier-legs', { dryRun });
  return {
    ok: status < 400,
    planned: dryRun,
    applied: !dryRun && status < 400,
    summary: dryRun
      ? `Would repair ${body?.marketsToRepair ?? 0} market(s) with ${body?.totalOrphanedLegs ?? 0} orphan leg(s)`
      : `Repaired ${body?.marketsToRepair ?? 0} market(s)`,
    details: body,
    reverseOp: NO_UNDO,
    httpStatus: status,
  };
}

async function fixStuckResolution(_db: SupabaseClient, finding: Finding, dryRun: boolean): Promise<FixOutcome> {
  const marketId = finding.affectedIds.marketId!;
  const { status, body } = await callEndpoint('/api/admin/repair-stuck-resolutions', { marketIds: [marketId], dryRun });
  return {
    ok: status < 400,
    planned: dryRun,
    applied: !dryRun && status < 400,
    summary: dryRun
      ? `Would resume market #${marketId}`
      : `Market #${marketId} resume: ${JSON.stringify(body?.results?.[0]?.resumeResult ?? {}).slice(0, 200)}`,
    details: body,
    reverseOp: NO_UNDO,
    httpStatus: status,
  };
}

async function fixWrongVoid(_db: SupabaseClient, finding: Finding, dryRun: boolean): Promise<FixOutcome> {
  const marketId = finding.affectedIds.marketId!;
  const outcome = finding.meta?.attemptedOutcome ?? finding.proposedFix?.body?.winningOutcomeIndices?.[0];
  if (outcome === undefined || outcome === null) {
    return {
      ok: false,
      summary: `Need an explicit winningOutcomeIndex for market #${marketId} — this fix cannot run without one.`,
      details: { marketId },
      httpStatus: 400,
    };
  }
  const { status, body } = await callEndpoint('/api/admin/re-resolve-voided-market', {
    marketId,
    winningOutcomeIndices: [outcome],
    dryRun,
  });
  return {
    ok: status < 400 && body?.dryRun === dryRun,
    planned: dryRun,
    applied: !dryRun && status < 400,
    summary: dryRun
      ? `Would re-resolve market #${marketId} at outcome ${outcome} (${body?.plan?.refundedBetCount ?? 0} refunded bets to unwind, ${body?.plan?.voidedLegCount ?? 0} voided legs)`
      : `Market #${marketId} re-resolved at outcome ${outcome}`,
    details: body,
    deltaTngn: Number(body?.plan?.totalClawbackTngn || 0),
    affectedUserIds: (body?.plan?.usersOwedClawback || []).map((u: any) => u.userId),
    reverseOp: NO_UNDO,
    httpStatus: status,
  };
}

async function fixGhostBets(_db: SupabaseClient, finding: Finding, dryRun: boolean): Promise<FixOutcome> {
  const marketId = finding.affectedIds.marketId!;
  const { status, body } = await callEndpoint('/api/admin/reconcile-void-losses', {
    marketIds: [marketId],
    dryRun,
    acknowledgeRefundOnly: !dryRun,   // required on apply
  });
  const affected = body?.affected?.[0];
  return {
    ok: status < 400,
    planned: dryRun,
    applied: !dryRun && status < 400,
    summary: dryRun
      ? `Would refund ${body?.totalGhosts ?? 0} ghost bet(s) totalling ₦${Math.round(body?.totalRefundTngn || 0).toLocaleString()} to ${body?.totalUsersAffected ?? 0} user(s)`
      : `Refunded ${body?.totalGhosts ?? 0} ghost bet(s) totalling ₦${Math.round(body?.totalRefundTngn || 0).toLocaleString()}`,
    details: body,
    deltaTngn: Number(body?.totalRefundTngn || 0),
    affectedUserIds: (affected?.plan || []).map((p: any) => p.userId),
    reverseOp: NO_UNDO,     // ghost refunds are already clamped-safe; undo would need per-user tracking
    httpStatus: status,
  };
}

async function fixOpenPastClose(_db: SupabaseClient, finding: Finding, dryRun: boolean): Promise<FixOutcome> {
  const marketId = finding.affectedIds.marketId!;
  if (dryRun) {
    return {
      ok: true,
      planned: true,
      summary: `Would force-lock market #${marketId} (past close, no bet flow impact)`,
      details: { marketId },
    };
  }
  const { status, body } = await callEndpoint('/api/markets/lock', { marketId });
  return {
    ok: status < 400,
    applied: status < 400,
    summary: status < 400
      ? `Market #${marketId} locked, ${body?.betCount ?? 0} bet(s) committed`
      : `Failed to lock market #${marketId}: ${body?.error ?? 'unknown'}`,
    details: body,
    reverseOp: NO_UNDO,
    httpStatus: status,
  };
}

// ── dispatcher ──────────────────────────────────────────────────────

const DISPATCH: Record<string, (db: SupabaseClient, f: Finding, dry: boolean) => Promise<FixOutcome>> = {
  stuck_slip: fixStuckSlip,
  orphaned_legs: fixOrphanedLegs,
  stuck_resolution: fixStuckResolution,
  wrong_void: fixWrongVoid,
  ghost_bets: fixGhostBets,
  open_past_close: fixOpenPastClose,
  // never_resolved: needs an admin to type the outcome — no auto fixer
  // negative_balance: manual investigation only — no auto fixer
  // voided_empty_duplicate: needs admin judgment
  // pending_deposit / slow_withdrawal: gateway-specific, wired in a later checkpoint
};

export const AUTO_TIER_ISSUE_TYPES: string[] = ['open_past_close'];
export const APPROVAL_ISSUE_TYPES: string[] = [
  'stuck_slip', 'orphaned_legs', 'stuck_resolution', 'wrong_void', 'ghost_bets',
];

export async function runFixForFinding(
  db: SupabaseClient,
  finding: Finding,
  opts: { dryRun: boolean; operator: string; runId?: string },
): Promise<FixOutcome> {
  const fixer = DISPATCH[finding.issueType];
  if (!fixer) {
    return {
      ok: false,
      summary: `No auto-fix registered for issueType '${finding.issueType}' — needs manual investigation.`,
      details: { finding },
    };
  }
  const outcome = await fixer(db, finding, opts.dryRun);

  // Log every fix attempt (dry or wet) to mechanic_log for the audit trail.
  await db.from('mechanic_log').insert({
    run_id: opts.runId || crypto.randomUUID(),
    scan_category: finding.category,
    action: opts.dryRun ? 'detect' : (outcome.ok ? 'fix' : 'error'),
    operator: opts.operator,
    issue_type: finding.issueType,
    issue_key: finding.fingerprint,
    affected_count: 1,
    delta_tngn: outcome.deltaTngn ?? null,
    affected_user_ids: outcome.affectedUserIds ?? null,
    details: { finding, outcome },
    reverse_op: outcome.reverseOp ?? null,
    succeeded: outcome.ok,
    error: outcome.ok ? null : (outcome.summary || 'fix failed'),
  }).then(() => undefined, () => undefined);

  // Mark the corresponding system_alert resolved on a successful apply.
  if (outcome.applied && outcome.ok) {
    await db.from('system_alerts').update({
      status: 'admin_resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: opts.operator,
    }).eq('fingerprint', finding.fingerprint);
  }

  return outcome;
}

// Rate-limit gate used by the cron heartbeat only. /ops button clicks
// are explicit human actions and bypass this check.
export async function isCircuitBreakerTripped(db: SupabaseClient, windowMinutes = 10, maxFixes = 20): Promise<{ tripped: boolean; recentFixCount: number }> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const { count } = await db
    .from('mechanic_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'fix')
    .eq('operator', 'mechanic')
    .gte('created_at', since);
  const recent = count ?? 0;
  return { tripped: recent >= maxFixes, recentFixCount: recent };
}

export function classifyTier(issueType: string): CascadeTier | null {
  if (AUTO_TIER_ISSUE_TYPES.includes(issueType)) return 'safe_auto';
  if (APPROVAL_ISSUE_TYPES.includes(issueType)) return 'approval_required';
  return null;
}
