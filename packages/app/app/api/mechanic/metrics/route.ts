import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/mechanic/metrics
//
// Small headline dashboard: complaint-to-fix SLA (median + p95 in
// minutes), auto-fixes applied in last 24h, active alerts by severity,
// last heartbeat timestamp.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [resolvedComplaints, autoFixes24h, openAlerts, state] = await Promise.all([
    supabaseAdmin.from('user_complaints').select('created_at, resolved_at').eq('status', 'resolved').gte('resolved_at', weekAgo).limit(500),
    supabaseAdmin.from('mechanic_log').select('id', { count: 'exact', head: true }).eq('action', 'fix').eq('operator', 'mechanic').gte('created_at', dayAgo),
    supabaseAdmin.from('system_alerts').select('severity').in('status', ['open', 'acknowledged']),
    supabaseAdmin.from('mechanic_state').select('*').eq('id', 1).maybeSingle(),
  ]);

  const times = (resolvedComplaints.data || [])
    .map(c => {
      if (!c.resolved_at || !c.created_at) return null;
      return (new Date(c.resolved_at).getTime() - new Date(c.created_at).getTime()) / 60000; // minutes
    })
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const median = times.length === 0 ? null : times[Math.floor(times.length / 2)];
  const p95 = times.length === 0 ? null : times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];

  const alertsBySeverity = { info: 0, warning: 0, critical: 0 };
  for (const a of openAlerts.data || []) {
    const s = a.severity as 'info' | 'warning' | 'critical';
    if (s in alertsBySeverity) alertsBySeverity[s] += 1;
  }

  return NextResponse.json({
    sla7d: {
      resolvedComplaintCount: times.length,
      medianMinutes: median,
      p95Minutes: p95,
    },
    autoFixesLast24h: autoFixes24h.count ?? 0,
    openAlerts: {
      total: (openAlerts.data || []).length,
      bySeverity: alertsBySeverity,
    },
    mechanic: {
      paused: !!state.data?.paused,
      lastScanAt: state.data?.last_scan_at,
      lastScanStatus: state.data?.last_scan_status,
      lastScanIssuesFound: state.data?.last_scan_issues_found,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
