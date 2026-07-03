import type { SupabaseClient } from '@supabase/supabase-js';
import type { Finding, IssueCategory, ScanResult } from './types';

// Every detector is a function returning Findings for one category.
// They MUST NOT mutate state — this file is read-only. Any mutation
// belongs in lib/mechanic/fixers.ts, dispatched from /api/mechanic/fix.

type Scanner = (db: SupabaseClient) => Promise<Finding[]>;

const ALL_CATEGORIES: IssueCategory[] = [
  'settlement',
  'balance',
  'deposit',
  'withdrawal',
  'market',
];

// ── settlement ──────────────────────────────────────────────────────
// Stuck slips (all legs settled, slip still active), orphaned legs
// (leg active on already-finalized market), stuck resolutions (market
// locked with resolved_outcome set — a crashed prior attempt), wrongly
// voided markets (voided with prior activity signals).

async function scanSettlement(db: SupabaseClient): Promise<Finding[]> {
  const findings: Finding[] = [];

  // 1. Stuck slips — legs done, slip still active.
  const { data: activeSlips } = await db
    .from('multiplier_slips')
    .select('id, user_id, legs_total, legs_resolved, net_slip_stake_tngn, created_at')
    .eq('status', 'active')
    .limit(500);
  if (activeSlips && activeSlips.length > 0) {
    const ids = activeSlips.map(s => s.id);
    const { data: legs } = await db
      .from('multiplier_legs')
      .select('slip_id, status')
      .in('slip_id', ids);
    const byId: Record<string, string[]> = {};
    for (const l of legs || []) (byId[l.slip_id] ||= []).push(l.status);
    for (const s of activeSlips) {
      const legStatuses = byId[s.id] || [];
      const allDone = legStatuses.length > 0 && legStatuses.every(st => st !== 'active');
      if (allDone) {
        findings.push({
          fingerprint: `stuck_slip:${s.id}`,
          category: 'settlement',
          issueType: 'stuck_slip',
          severity: 'warning',
          tier: 'approval_required',
          title: `Slip stuck at 'active' — all legs already settled`,
          detail: `Slip ${s.id} has ${legStatuses.length} legs, all in final states, but the slip itself never advanced. Needs finalize_stalled_slip.`,
          affectedIds: { slipId: s.id, userId: s.user_id },
          meta: { legStatuses, netStakeTngn: Number(s.net_slip_stake_tngn), createdAt: s.created_at },
          proposedFix: {
            endpoint: '/api/admin/finalize-stalled-slips',
            method: 'POST',
            body: { slipIds: [s.id], dryRun: false },
            dryRun: true,
          },
        });
      }
    }
  }

  // 2. Orphaned legs — leg active on a market that's already resolved/voided.
  const { data: orphanCandidates } = await db
    .from('multiplier_legs')
    .select('market_id, id, slip_id')
    .eq('status', 'active')
    .limit(1000);
  if (orphanCandidates && orphanCandidates.length > 0) {
    const marketIds = Array.from(new Set(orphanCandidates.map(l => l.market_id)));
    const { data: mkts } = await db
      .from('markets')
      .select('id, status')
      .in('id', marketIds)
      .in('status', ['resolved', 'voided']);
    const finishedMarketIds = new Set((mkts || []).map(m => m.id));
    const orphans = orphanCandidates.filter(l => finishedMarketIds.has(l.market_id));
    // Aggregate by market_id so we don't spam one finding per leg.
    const byMarket: Record<number, { legIds: string[]; slipIds: Set<string> }> = {};
    for (const l of orphans) {
      const b = (byMarket[l.market_id] ||= { legIds: [], slipIds: new Set() });
      b.legIds.push(l.id);
      b.slipIds.add(l.slip_id);
    }
    for (const [mid, agg] of Object.entries(byMarket)) {
      findings.push({
        fingerprint: `orphaned_legs:${mid}`,
        category: 'settlement',
        issueType: 'orphaned_legs',
        severity: 'warning',
        tier: 'approval_required',
        title: `${agg.legIds.length} multiplier leg(s) stuck on already-finalized market #${mid}`,
        detail: `Market ${mid} is resolved/voided, but ${agg.legIds.length} legs riding on it still show 'active'. Slips can't advance. repair-multiplier-legs will settle them.`,
        affectedIds: { marketId: Number(mid), legIds: agg.legIds, slipIds: Array.from(agg.slipIds) },
        meta: { legCount: agg.legIds.length, slipCount: agg.slipIds.size },
        proposedFix: {
          endpoint: '/api/admin/repair-multiplier-legs',
          method: 'POST',
          body: { dryRun: false },
          dryRun: true,
        },
      });
    }
  }

  // 3. Stuck resolutions — market claimed but stuck in 'locked'.
  const { data: stuck } = await db
    .from('markets')
    .select('id, question, resolved_outcome, resolved_outcomes, resolved_at')
    .eq('status', 'locked')
    .not('resolved_outcome', 'is', null)
    .limit(200);
  for (const m of stuck || []) {
    findings.push({
      fingerprint: `stuck_resolution:${m.id}`,
      category: 'settlement',
      issueType: 'stuck_resolution',
      severity: 'critical',
      tier: 'approval_required',
      title: `Market #${m.id} claimed but never finalized`,
      detail: `resolved_outcome is set (${m.resolved_outcome ?? m.resolved_outcomes}) but status is still 'locked' — a prior resolve attempt died mid-settlement. Bets and legs on this market can't advance until it's resumed.`,
      affectedIds: { marketId: m.id },
      meta: { question: m.question, resolvedAt: m.resolved_at },
      proposedFix: {
        endpoint: '/api/admin/repair-stuck-resolutions',
        method: 'POST',
        body: { marketIds: [m.id], dryRun: false },
        dryRun: true,
      },
    });
  }

  // 4. Wrongly voided (voided_with_outcome — the old bad refund fingerprint).
  const { data: wrongVoided } = await db
    .from('markets')
    .select('id, question, resolved_outcome, resolved_outcomes, resolved_at')
    .eq('status', 'voided')
    .not('resolved_outcome', 'is', null)
    .gte('resolved_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .limit(200);
  for (const m of wrongVoided || []) {
    findings.push({
      fingerprint: `wrong_void:${m.id}`,
      category: 'settlement',
      issueType: 'wrong_void',
      severity: 'critical',
      tier: 'approval_required',
      title: `Market #${m.id} voided but has a real winning outcome`,
      detail: `Voided with resolved_outcome=${m.resolved_outcome} — the old wrongful-void fingerprint. Users may have had winning bets refunded at stake instead of paid at odds.`,
      affectedIds: { marketId: m.id },
      meta: { question: m.question },
      proposedFix: {
        endpoint: '/api/admin/re-resolve-voided-market',
        method: 'POST',
        body: { marketId: m.id, winningOutcomeIndices: [m.resolved_outcome], dryRun: false },
        dryRun: true,
      },
    });
  }

  // 5. Voided-empty markets whose question exists as another row —
  // real bets may live on that other row.
  const { data: emptyVoided } = await db
    .from('markets')
    .select('id, question, resolved_at')
    .eq('status', 'voided')
    .is('resolved_outcome', null)
    .gte('resolved_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .limit(200);
  for (const m of emptyVoided || []) {
    if (!m.question) continue;
    const { data: dupes } = await db.from('markets').select('id, status').eq('question', m.question).neq('id', m.id);
    if (!dupes || dupes.length === 0) continue;
    findings.push({
      fingerprint: `voided_empty_duplicate:${m.id}`,
      category: 'settlement',
      issueType: 'voided_empty_duplicate',
      severity: 'critical',
      tier: 'approval_required',
      title: `Market #${m.id} voided empty — but has ${dupes.length} duplicate market row(s)`,
      detail: `Same question text exists as market ${dupes.map(d => `#${d.id} (${d.status})`).join(', ')}. Bets probably landed on the other row while this one was voided as empty.`,
      affectedIds: { marketId: m.id, marketIds: dupes.map(d => d.id) },
      meta: { question: m.question, duplicates: dupes },
    });
  }

  return findings;
}

// ── balance ─────────────────────────────────────────────────────────
// Negative bonus balance (invariant violation), ghost bets (entry_rake
// row present but no user_bets row).

async function scanBalance(db: SupabaseClient): Promise<Finding[]> {
  const findings: Finding[] = [];

  const { data: negs } = await db
    .from('users')
    .select('id, email, bonus_balance, tngn_balance')
    .or('bonus_balance.lt.0,tngn_balance.lt.0')
    .limit(200);
  for (const u of negs || []) {
    findings.push({
      fingerprint: `negative_balance:${u.id}`,
      category: 'balance',
      issueType: 'negative_balance',
      severity: 'critical',
      tier: 'approval_required',
      title: `User ${u.email || u.id} has a negative balance`,
      detail: `tngn=${u.tngn_balance}, bonus=${u.bonus_balance}. Invariant violation — should never happen. Zero out and investigate the credit_user path.`,
      affectedIds: { userId: u.id },
      meta: { tngnBalance: Number(u.tngn_balance), bonusBalance: Number(u.bonus_balance) },
    });
  }

  // Ghost bets: entry_rake row in the last 7d referencing a bet_id
  // that no user_bets row has anymore. That's independent proof a bet
  // was placed and the row is gone.
  const { data: recentRakes } = await db
    .from('treasury_log')
    .select('id, bet_id, user_id, market_id, amount_tngn, created_at')
    .eq('type', 'entry_rake')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(2000);
  const betIdsFromRakes = Array.from(new Set((recentRakes || []).map(r => r.bet_id).filter(Boolean)));
  if (betIdsFromRakes.length > 0) {
    const { data: existingBets } = await db.from('user_bets').select('id').in('id', betIdsFromRakes);
    const existingSet = new Set((existingBets || []).map(b => b.id));
    // Skip ghosts that have already been recovered by a prior tool run.
    const { data: recoveries } = await db
      .from('treasury_log')
      .select('bet_id')
      .eq('type', 'void_loss_recovery')
      .in('bet_id', betIdsFromRakes);
    const recovered = new Set((recoveries || []).map(r => r.bet_id));
    const ghosts = (recentRakes || []).filter(r => r.bet_id && !existingSet.has(r.bet_id) && !recovered.has(r.bet_id));
    if (ghosts.length > 0) {
      const byMarket: Record<string, typeof ghosts> = {};
      for (const g of ghosts) (byMarket[String(g.market_id)] ||= [] as any).push(g);
      for (const [marketId, gg] of Object.entries(byMarket)) {
        findings.push({
          fingerprint: `ghost_bets:${marketId}`,
          category: 'balance',
          issueType: 'ghost_bets',
          severity: 'critical',
          tier: 'approval_required',
          title: `${gg.length} ghost bet(s) on market #${marketId}`,
          detail: `Entry_rake rows exist for bets whose user_bets row is missing — real stakes were taken and the record is gone. Refund via reconcile-void-losses (bonus credit, clawable).`,
          affectedIds: { marketId: Number(marketId), userIds: Array.from(new Set(gg.map(g => g.user_id))) },
          meta: { ghostCount: gg.length, totalRakeTngn: gg.reduce((s, g) => s + Number(g.amount_tngn || 0), 0) },
          proposedFix: {
            endpoint: '/api/admin/reconcile-void-losses',
            method: 'POST',
            body: { marketIds: [Number(marketId)], dryRun: false, acknowledgeRefundOnly: true },
            dryRun: true,
          },
        });
      }
    }
  }

  return findings;
}

// ── deposit ─────────────────────────────────────────────────────────
// Pending deposits older than 30 min — webhook probably lost or the
// gateway is lagging. We only detect here; the fix is a per-gateway
// re-query in the fix dispatcher.

async function scanDeposit(db: SupabaseClient): Promise<Finding[]> {
  const findings: Finding[] = [];

  // squad_transactions is the deposit table. Look for anything still
  // "pending" past a reasonable webhook window.
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: stalePending, error } = await db
    .from('squad_transactions')
    .select('id, user_id, amount, reference, status, created_at')
    .in('status', ['pending', 'initiated'])
    .lt('created_at', cutoff)
    .limit(200);
  // squad_transactions may not exist in every env — treat missing
  // table as "no findings" rather than an error.
  if (error && (error as any).code !== 'PGRST205' && (error as any).code !== '42P01') throw error;
  for (const t of stalePending || []) {
    findings.push({
      fingerprint: `pending_deposit:${t.id}`,
      category: 'deposit',
      issueType: 'pending_deposit',
      severity: 'warning',
      tier: 'approval_required',
      title: `Deposit stuck 'pending' for over 30 min`,
      detail: `Reference ${t.reference}, ₦${Number(t.amount).toLocaleString()}. Re-query the gateway; if it confirms, credit the user. If it never confirmed, mark failed.`,
      affectedIds: { userId: t.user_id },
      meta: { reference: t.reference, amount: Number(t.amount), createdAt: t.created_at },
    });
  }

  return findings;
}

// ── withdrawal ──────────────────────────────────────────────────────
// Approved withdrawals older than 2h that haven't paid out.

async function scanWithdrawal(db: SupabaseClient): Promise<Finding[]> {
  const findings: Finding[] = [];
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: stuck, error } = await db
    .from('withdrawals')
    .select('id, user_id, amount, status, created_at, updated_at')
    .in('status', ['approved', 'processing'])
    .lt('updated_at', cutoff)
    .limit(200);
  if (error && (error as any).code !== 'PGRST205' && (error as any).code !== '42P01') throw error;
  for (const w of stuck || []) {
    findings.push({
      fingerprint: `slow_withdrawal:${w.id}`,
      category: 'withdrawal',
      issueType: 'slow_withdrawal',
      severity: 'warning',
      tier: 'approval_required',
      title: `Withdrawal stuck '${w.status}' for over 2 hours`,
      detail: `₦${Number(w.amount).toLocaleString()} to user ${w.user_id}. Check gateway status. If it silently failed, refund the balance.`,
      affectedIds: { userId: w.user_id },
      meta: { amount: Number(w.amount), status: w.status, updatedAt: w.updated_at },
    });
  }
  return findings;
}

// ── market ──────────────────────────────────────────────────────────
// Never-resolved markets (locked past close + no resolve attempted),
// markets stuck open past close time, duplicate market rows.

async function scanMarket(db: SupabaseClient): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Markets stuck open past close.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: openPast } = await db
    .from('markets')
    .select('id, question, closes_at')
    .eq('status', 'open')
    .lt('closes_at', twoHoursAgo)
    .limit(200);
  for (const m of openPast || []) {
    findings.push({
      fingerprint: `open_past_close:${m.id}`,
      category: 'market',
      issueType: 'open_past_close',
      severity: 'warning',
      tier: 'safe_auto',
      title: `Market #${m.id} still 'open' past close time`,
      detail: `closes_at was ${m.closes_at} — cron missed the lock. Force-lock safely.`,
      affectedIds: { marketId: m.id },
      meta: { question: m.question, closesAt: m.closes_at },
      proposedFix: {
        endpoint: '/api/markets/lock',
        method: 'POST',
        body: { marketId: m.id },
        dryRun: false,
      },
    });
  }

  // Never-resolved locked markets past a generous window.
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: neverResolved } = await db
    .from('markets')
    .select('id, question, closes_at, resolution_attempts')
    .eq('status', 'locked')
    .is('resolved_outcome', null)
    .lt('closes_at', sixHoursAgo)
    .limit(200);
  for (const m of neverResolved || []) {
    findings.push({
      fingerprint: `never_resolved:${m.id}`,
      category: 'market',
      issueType: 'never_resolved',
      severity: 'warning',
      tier: 'approval_required',
      title: `Market #${m.id} locked >6h without resolution`,
      detail: `closes_at ${m.closes_at}, attempts ${(m as any).resolution_attempts ?? 0}. Oracle lookup keeps failing or this needs manual resolution.`,
      affectedIds: { marketId: m.id },
      meta: { question: m.question, closesAt: m.closes_at },
    });
  }

  return findings;
}

// ── orchestrator ────────────────────────────────────────────────────

const SCANNERS: Record<IssueCategory, Scanner | null> = {
  settlement: scanSettlement,
  balance: scanBalance,
  deposit: scanDeposit,
  withdrawal: scanWithdrawal,
  market: scanMarket,
  complaint_auto_fix: null,
  post_deploy: null,
  manual: null,
};

export async function runMechanicScan(
  db: SupabaseClient,
  opts: { scope?: string[] } = {},
): Promise<ScanResult> {
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const scope = (opts.scope && opts.scope.length > 0)
    ? opts.scope.filter(s => ALL_CATEGORIES.includes(s as IssueCategory)) as IssueCategory[]
    : ALL_CATEGORIES;

  const results = await Promise.allSettled(
    scope.map(async (cat) => {
      const scanner = SCANNERS[cat];
      if (!scanner) return { cat, findings: [] as Finding[] };
      const findings = await scanner(db);
      return { cat, findings };
    }),
  );

  const findings: Finding[] = [];
  const scanErrors: Array<{ category: IssueCategory; error: string }> = [];
  const countsByCategory: Record<IssueCategory, number> = {
    settlement: 0, balance: 0, deposit: 0, withdrawal: 0, market: 0,
    complaint_auto_fix: 0, post_deploy: 0, manual: 0,
  };

  results.forEach((r, i) => {
    const cat = scope[i];
    if (r.status === 'fulfilled') {
      findings.push(...r.value.findings);
      countsByCategory[cat] += r.value.findings.length;
    } else {
      scanErrors.push({ category: cat, error: (r.reason as any)?.message || String(r.reason) });
    }
  });

  // Upsert findings into system_alerts by fingerprint — first seen /
  // last seen / occurrence_count get maintained automatically.
  //
  // IMPORTANT: a fingerprint that's already 'admin_resolved' means a
  // human explicitly reviewed it and dismissed it (e.g. two market
  // rows are permanent, harmless duplicates — the underlying condition
  // will never go away on its own). Re-detecting the same condition on
  // the next scan must NOT silently flip that back to 'open' — that
  // would undo the admin's decision within one scan interval and make
  // "acknowledge" pointless for anything that isn't naturally self-
  // resolving. Only fingerprints NOT already admin_resolved get their
  // status reset to 'open'; admin_resolved rows just get last_seen_at
  // bumped so they don't look stale, but keep their resolved state.
  //
  // Same set is used below to filter dismissed findings OUT of what
  // this function returns — otherwise /ops would keep showing an item
  // right after an admin dismissed it, since the underlying DB
  // condition (e.g. the duplicate market rows) never actually changes
  // and the scanner would just re-detect it every 30s regardless of
  // system_alerts state.
  let adminResolvedSet = new Set<string>();
  if (findings.length > 0) {
    const allFingerprints = findings.map(f => f.fingerprint);
    const { data: existing } = await db
      .from('system_alerts')
      .select('fingerprint, status')
      .in('fingerprint', allFingerprints);
    adminResolvedSet = new Set((existing || []).filter(e => e.status === 'admin_resolved').map(e => e.fingerprint));

    const toReopen = findings.filter(f => !adminResolvedSet.has(f.fingerprint));
    const toBumpOnly = findings.filter(f => adminResolvedSet.has(f.fingerprint));

    if (toReopen.length > 0) {
      const upserts = toReopen.map(f => ({
        severity: f.severity,
        category: f.category,
        title: f.title,
        message: f.detail,
        fingerprint: f.fingerprint,
        affected_ids: f.affectedIds as any,
        status: 'open',
        last_seen_at: new Date().toISOString(),
      }));
      await db.from('system_alerts').upsert(upserts as any, {
        onConflict: 'fingerprint',
        ignoreDuplicates: false,
      });
    }
    if (toBumpOnly.length > 0) {
      await db.from('system_alerts')
        .update({ last_seen_at: new Date().toISOString() })
        .in('fingerprint', toBumpOnly.map(f => f.fingerprint));
    }
    // Bump occurrence_count on rows that were already there.
    // Postgres UPSERT can't add-1 in supabase-js — do it as a separate
    // update on the affected fingerprints in one shot.
    await db.rpc('bump_alert_occurrences' as any, { p_fingerprints: allFingerprints }).then(() => undefined, () => undefined);
  }

  // Drop dismissed findings from what we return + count. They're still
  // "detected" internally (system_alerts.last_seen_at just got bumped
  // above) but an admin already reviewed them — they shouldn't clutter
  // the live queue again.
  if (adminResolvedSet.size > 0) {
    for (let i = findings.length - 1; i >= 0; i--) {
      if (adminResolvedSet.has(findings[i].fingerprint)) {
        countsByCategory[findings[i].category] -= 1;
        findings.splice(i, 1);
      }
    }
  }

  // Auto-resolve alerts whose fingerprints are NO LONGER in the scan.
  // Scoped to the categories we actually ran, so a partial scan doesn't
  // wrongly resolve alerts for a category we didn't touch.
  const activeFingerprints = new Set(findings.map(f => f.fingerprint));
  const { data: openAlerts } = await db
    .from('system_alerts')
    .select('id, fingerprint, category')
    .in('status', ['open', 'acknowledged'])
    .in('category', scope);
  const stale = (openAlerts || []).filter(a => !activeFingerprints.has(a.fingerprint));
  if (stale.length > 0) {
    await db
      .from('system_alerts')
      .update({ status: 'auto_resolved', resolved_at: new Date().toISOString(), resolved_by: 'auto' })
      .in('id', stale.map(a => a.id));
  }

  const totalFindings = findings.length;
  const durationMs = Date.now() - startedAt;

  // One 'detect' summary row into mechanic_log. Individual per-finding
  // rows would blow up log volume without much added value — the
  // system_alerts table already holds the per-issue trail.
  await db.from('mechanic_log').insert({
    run_id: runId,
    scan_category: 'manual',
    action: 'detect',
    operator: 'mechanic',
    issue_type: 'scan_summary',
    affected_count: totalFindings,
    details: {
      scope, countsByCategory, scanErrors, durationMs,
      autoResolved: stale.length,
    },
    succeeded: scanErrors.length === 0,
  });

  await db.from('mechanic_state').update({
    last_scan_at: new Date().toISOString(),
    last_scan_status: scanErrors.length === 0 ? 'ok' : 'partial',
    last_scan_issues_found: totalFindings,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);

  return {
    runId,
    scannedAt: new Date().toISOString(),
    scopeApplied: scope,
    findings,
    countsByCategory,
    totalFindings,
    scanErrors,
    durationMs,
  };
}
