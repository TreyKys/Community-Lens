import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runMechanicScan } from '@/lib/mechanic/scans';
import { runFixForFinding, isCircuitBreakerTripped, AUTO_TIER_ISSUE_TYPES } from '@/lib/mechanic/fixers';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/mechanic/heartbeat
//
// The Mechanic cron. Every N minutes (Netlify Scheduled Functions or
// pg_cron, whichever is easier — this route just needs to be hit on a
// schedule with the CRON_SECRET header):
//
//   1. If mechanic_state.paused is true — do nothing.
//   2. Take a single-runner advisory lock so a concurrent trigger
//      (Netlify sometimes fires twice) doesn't run both instances.
//   3. Circuit breaker: if >= 20 fixer-owned rows landed in
//      mechanic_log in the last 10 minutes, pause and alert. A run-
//      away fixer stops here rather than compounding.
//   4. runMechanicScan → gets Findings.
//   5. For every safe_auto tier finding, apply the fix (no dryRun).
//      approval_required findings are left for /ops.
//
// Everything gets a mechanic_log row via runFixForFinding, so the
// audit trail is complete no matter which surface invoked which fix.
export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const runId = crypto.randomUUID();

  // ── check paused ──────────────────────────────────────────────────
  const { data: state } = await supabaseAdmin
    .from('mechanic_state')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (state?.paused) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: `paused: ${state.pause_reason || 'no reason recorded'}`,
    });
  }

  // ── single-runner advisory lock ───────────────────────────────────
  // 4242424242 is an arbitrary constant; the lock key just needs to
  // be stable across invocations. try_advisory_lock returns false if
  // another session already holds it — we exit cleanly in that case.
  let gotLock = false;
  try {
    const { data: lockRow } = await supabaseAdmin.rpc('mechanic_heartbeat_try_lock' as any).single<{ locked: boolean }>();
    gotLock = !!lockRow?.locked;
  } catch {
    // If the RPC doesn't exist yet (migration not applied) skip the
    // lock — the heartbeat still runs, we just can't guarantee single-
    // runner behaviour. Better than 500ing the whole cron.
    gotLock = true;
  }
  if (!gotLock) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'another heartbeat is running' });
  }

  try {
    // ── circuit breaker ────────────────────────────────────────────
    const { tripped, recentFixCount } = await isCircuitBreakerTripped(supabaseAdmin);
    if (tripped) {
      await supabaseAdmin.from('mechanic_state').update({
        paused: true,
        pause_reason: `Circuit breaker: ${recentFixCount} fixes in the last 10 min. Manual review before resuming.`,
        paused_at: new Date().toISOString(),
        paused_by: 'circuit_breaker',
        updated_at: new Date().toISOString(),
      }).eq('id', 1);
      await supabaseAdmin.from('notifications').insert({
        user_id: null,
        type: 'admin_alert',
        severity: 'critical',
        category: 'mechanic',
        message: `⚠️ Mechanic paused itself — circuit breaker tripped after ${recentFixCount} fixes in 10 min. Investigate before unpausing at /ops.`,
      });
      return NextResponse.json({ ok: true, skipped: true, reason: 'circuit breaker tripped', recentFixCount });
    }

    // ── scan ────────────────────────────────────────────────────────
    const scan = await runMechanicScan(supabaseAdmin, {});

    // ── auto-apply safe_auto findings only ─────────────────────────
    const toApply = scan.findings.filter(f => AUTO_TIER_ISSUE_TYPES.includes(f.issueType));
    let applied = 0;
    let failed = 0;
    for (const f of toApply) {
      const out = await runFixForFinding(supabaseAdmin, f, {
        dryRun: false,
        operator: 'mechanic',
        runId,
      });
      if (out.ok && out.applied) applied += 1; else failed += 1;
    }

    await supabaseAdmin.from('mechanic_state').update({
      last_scan_at: new Date().toISOString(),
      last_scan_status: scan.scanErrors.length === 0 ? 'ok' : 'partial',
      last_scan_issues_found: scan.totalFindings,
      last_scan_fixes_applied: applied,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);

    return NextResponse.json({
      ok: true,
      runId,
      durationMs: Date.now() - startedAt,
      totalFindings: scan.totalFindings,
      autoFixesAttempted: toApply.length,
      autoFixesApplied: applied,
      autoFixesFailed: failed,
      countsByCategory: scan.countsByCategory,
    });
  } finally {
    // Release the advisory lock. Errors are non-fatal — the lock is
    // session-scoped and will drop when the connection closes anyway.
    try { await supabaseAdmin.rpc('mechanic_heartbeat_unlock' as any); } catch { /* ignore */ }
  }
}
