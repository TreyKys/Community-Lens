import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runMechanicScan } from '@/lib/mechanic/scans';
import { safeSecretMatch } from '@/lib/safeCompare';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/mechanic/post-deploy
//
// Fires after every deploy: runs a full detection scan immediately, records
// the run tagged 'post_deploy', and posts an admin_alert notification if the
// scan found new critical findings.
//
// Auth: the deploy webhook secret OR the same CRON_SECRET the heartbeat uses,
// whichever the caller sends. Both map to the same effective operator.
//
// Host-agnostic (we self-host on AWS now, not Netlify):
//   * header  x-deploy-secret   (or legacy x-netlify-deploy-secret)
//   * env     DEPLOY_SECRET     (or legacy NETLIFY_DEPLOY_SECRET)
// Call it as the last step of scripts/deploy.sh, or from any CI job:
//   curl -X POST "$APP_URL/api/mechanic/post-deploy" -H "x-cron-secret: $CRON_SECRET"
export async function POST(request: Request) {
  const cron = request.headers.get('x-cron-secret');
  // Accept the legacy Netlify header/env during the cutover so the hook keeps
  // working whichever host is live at the moment.
  const deploy =
    request.headers.get('x-deploy-secret') ??
    request.headers.get('x-netlify-deploy-secret');
  const deploySecret = process.env.DEPLOY_SECRET || process.env.NETLIFY_DEPLOY_SECRET;
  const okAuth =
    safeSecretMatch(cron, process.env.CRON_SECRET) ||
    safeSecretMatch(deploy, deploySecret);
  if (!okAuth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startedAt = Date.now();
  const scan = await runMechanicScan(supabaseAdmin, {});

  // Log as post_deploy so filtering the mechanic_log surfaces "what
  // did this deploy break" easily.
  await supabaseAdmin.from('mechanic_log').insert({
    run_id: scan.runId,
    scan_category: 'post_deploy',
    action: 'detect',
    operator: 'post_deploy',
    issue_type: 'post_deploy_scan',
    affected_count: scan.totalFindings,
    details: {
      totalFindings: scan.totalFindings,
      countsByCategory: scan.countsByCategory,
      criticalCount: scan.findings.filter(f => f.severity === 'critical').length,
      durationMs: Date.now() - startedAt,
    },
    succeeded: scan.scanErrors.length === 0,
  });

  const critical = scan.findings.filter(f => f.severity === 'critical');
  if (critical.length > 0) {
    await supabaseAdmin.from('notifications').insert({
      user_id: null,
      type: 'admin_alert',
      severity: 'critical',
      category: 'post_deploy',
      message: `🚨 Post-deploy scan surfaced ${critical.length} critical issue(s) — check /ops.`,
    });
  }

  return NextResponse.json({
    ok: true,
    runId: scan.runId,
    totalFindings: scan.totalFindings,
    critical: critical.length,
    countsByCategory: scan.countsByCategory,
    durationMs: Date.now() - startedAt,
  });
}
