'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Activity, AlertTriangle, CheckCircle2, RefreshCw, Wrench, MessageSquare, PauseCircle, PlayCircle, Eye, ShieldAlert, MessageCircle, User as UserIcon, Send, Users as UsersIcon, RotateCcw } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// /ops — Monitor & Mechanic control panel.
//
// Deliberately separate from /admin so the ops flow is one focused
// surface: scan, fix, respond to complaints. Same admin-cookie gate.
//
// Auth is checked by pinging /api/admin/heartbeat on mount — if we get
// 401 back the page renders a "sign in on /admin first" prompt instead
// of trying to render an admin form the browser would immediately
// bounce out of.

const adminHeaders = () => ({ 'Content-Type': 'application/json' });

interface Finding {
  fingerprint: string;
  category: string;
  issueType: string;
  severity: 'info' | 'warning' | 'critical';
  tier: 'safe_auto' | 'approval_required';
  title: string;
  detail: string;
  affectedIds: Record<string, any>;
  meta?: Record<string, any>;
  proposedFix?: { endpoint: string; method: string; body: any; dryRun: boolean };
}

interface ScanResult {
  runId: string;
  scannedAt: string;
  findings: Finding[];
  countsByCategory: Record<string, number>;
  totalFindings: number;
  scanErrors: Array<{ category: string; error: string }>;
  durationMs: number;
}

export default function OpsPage() {
  const { toast } = useToast();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [mechanicState, setMechanicState] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);

  // Auth handshake — sees if the admin cookie is set.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/admin/heartbeat', { method: 'POST', credentials: 'include' });
        setAuthed(r.ok);
      } catch { setAuthed(false); }
    })();
  }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const r = await fetch(`/api/mechanic/scan?_=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setScan(await r.json());
    } catch (e: any) {
      toast({ title: 'Scan failed', description: e.message, variant: 'destructive' });
    } finally {
      setScanning(false);
    }
  }, [toast]);

  const loadState = useCallback(async () => {
    try {
      const [{ data }, mRes] = await Promise.all([
        supabase.from('mechanic_state').select('*').eq('id', 1).maybeSingle(),
        fetch(`/api/mechanic/metrics?_=${Date.now()}`, { credentials: 'include', cache: 'no-store' }),
      ]);
      setMechanicState(data);
      if (mRes.ok) setMetrics(await mRes.json());
    } catch { /* not critical */ }
  }, []);

  useEffect(() => {
    if (authed) { runScan(); loadState(); }
  }, [authed, runScan, loadState]);

  // Auto-refresh every 30s while the tab is visible.
  useEffect(() => {
    if (!authed || !autoRefresh) return;
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') { runScan(); loadState(); }
    }, 30_000);
    return () => clearInterval(iv);
  }, [authed, autoRefresh, runScan, loadState]);

  if (authed === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="max-w-md mx-auto py-24 px-4 text-center space-y-3">
        <h1 className="text-xl font-semibold">Admin sign-in required</h1>
        <p className="text-sm text-muted-foreground">
          /ops uses the same admin cookie as /admin. Sign in there first,
          then come back to this page.
        </p>
        <Button asChild variant="outline"><a href="/admin">Go to /admin</a></Button>
      </div>
    );
  }

  const findings = scan?.findings || [];
  const counts = scan?.countsByCategory || {};
  const criticalCount = findings.filter(f => f.severity === 'critical').length;

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-3">
          <Activity className="w-6 h-6 text-emerald-400" />
          <div>
            <h1 className="text-2xl font-bold">/ops</h1>
            <p className="text-xs text-muted-foreground">
              Monitor &amp; Mechanic — {scan
                ? `${scan.totalFindings} issue(s) detected · scanned ${new Date(scan.scannedAt).toLocaleTimeString()} · ${scan.durationMs}ms`
                : 'ready'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mechanicState?.paused ? (
            <Button
              size="sm"
              variant="outline"
              className="border-amber-500/30 text-amber-300 gap-1.5"
              onClick={async () => {
                await fetch('/api/mechanic/state', {
                  method: 'POST', headers: adminHeaders(), credentials: 'include',
                  body: JSON.stringify({ action: 'unpause' }),
                });
                loadState();
                toast({ title: 'Mechanic auto-fix resumed' });
              }}
              title={mechanicState.pause_reason}
            >
              <PauseCircle className="w-3 h-3" /> Paused — resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground gap-1.5"
              onClick={async () => {
                if (!confirm('Pause Mechanic auto-fix? Approval-required fixes on /ops still work; only the safe-auto cron stops.')) return;
                await fetch('/api/mechanic/state', {
                  method: 'POST', headers: adminHeaders(), credentials: 'include',
                  body: JSON.stringify({ action: 'pause', reason: 'Paused from /ops' }),
                });
                loadState();
                toast({ title: 'Mechanic auto-fix paused' });
              }}
            >
              <PauseCircle className="w-3 h-3" /> Pause auto
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? 'Auto-refresh on' : 'Auto-refresh off'}
          >
            {autoRefresh ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}
          </Button>
          <Button size="sm" onClick={runScan} disabled={scanning} className="gap-2">
            {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Re-scan
          </Button>
        </div>
      </div>

      {/* Metrics strip */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <SummaryTile
            label="SLA median (7d)"
            value={metrics.sla7d?.medianMinutes != null ? `${Math.round(metrics.sla7d.medianMinutes)}m` : '—' as any}
            tone={metrics.sla7d?.medianMinutes != null && metrics.sla7d.medianMinutes > 240 ? 'warn' : 'ok'}
          />
          <SummaryTile
            label="SLA p95 (7d)"
            value={metrics.sla7d?.p95Minutes != null ? `${Math.round(metrics.sla7d.p95Minutes)}m` : '—' as any}
            tone={metrics.sla7d?.p95Minutes != null && metrics.sla7d.p95Minutes > 1440 ? 'warn' : 'ok'}
          />
          <SummaryTile
            label="Auto-fixes 24h"
            value={metrics.autoFixesLast24h ?? 0}
            tone={(metrics.autoFixesLast24h ?? 0) > 15 ? 'warn' : 'ok'}
          />
          <SummaryTile
            label="Open alerts"
            value={metrics.openAlerts?.total ?? 0}
            tone={(metrics.openAlerts?.bySeverity?.critical || 0) > 0 ? 'critical'
                : (metrics.openAlerts?.bySeverity?.warning || 0) > 0 ? 'warn' : 'ok'}
          />
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <SummaryTile label="Total" value={scan?.totalFindings ?? 0} tone="neutral" />
        <SummaryTile label="Critical" value={criticalCount} tone={criticalCount > 0 ? 'critical' : 'ok'} />
        <SummaryTile label="Settlement" value={counts.settlement ?? 0} tone={counts.settlement ? 'warn' : 'ok'} />
        <SummaryTile label="Balance" value={counts.balance ?? 0} tone={counts.balance ? 'critical' : 'ok'} />
        <SummaryTile label="Deposit" value={counts.deposit ?? 0} tone={counts.deposit ? 'warn' : 'ok'} />
        <SummaryTile label="Market" value={counts.market ?? 0} tone={counts.market ? 'warn' : 'ok'} />
      </div>

      {scan?.scanErrors && scan.scanErrors.length > 0 && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="py-3 text-xs text-red-300">
            <strong>Scan errors:</strong>{' '}
            {scan.scanErrors.map(e => `${e.category}: ${e.error}`).join(' · ')}
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="monitor">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="monitor">
            <Activity className="w-3 h-3 mr-1.5" /> Monitor
          </TabsTrigger>
          <TabsTrigger value="mechanic">
            <Wrench className="w-3 h-3 mr-1.5" /> Mechanic
          </TabsTrigger>
          <TabsTrigger value="complaints">
            <MessageSquare className="w-3 h-3 mr-1.5" /> Complaints
          </TabsTrigger>
        </TabsList>

        {/* Monitor: read-only view of all findings, grouped */}
        <TabsContent value="monitor" className="pt-4">
          <MonitorPanel findings={findings} scanning={scanning} />
        </TabsContent>

        {/* Mechanic: findings with Fix buttons + preview-before-apply */}
        <TabsContent value="mechanic" className="pt-4">
          <MechanicPanel findings={findings} onFixed={runScan} />
        </TabsContent>

        {/* Complaints inbox */}
        <TabsContent value="complaints" className="pt-4">
          <ComplaintsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number | string; tone: 'ok' | 'warn' | 'critical' | 'neutral' }) {
  const toneClasses = {
    ok:       'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
    warn:     'bg-amber-500/10 border-amber-500/20 text-amber-300',
    critical: 'bg-red-500/10 border-red-500/20 text-red-300',
    neutral:  'bg-muted/20 border-muted text-foreground',
  }[tone];
  return (
    <div className={cn('border rounded-lg p-3 text-center', toneClasses)}>
      <p className="text-[10px] uppercase tracking-wider opacity-80">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function MonitorPanel({ findings, scanning }: { findings: Finding[]; scanning: boolean }) {
  if (findings.length === 0 && !scanning) {
    return (
      <div className="border rounded-lg p-8 text-center space-y-2">
        <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
        <p className="text-sm font-medium">All clear — no issues detected.</p>
        <p className="text-xs text-muted-foreground">
          Monitor auto-scans every 30s while this tab is open.
        </p>
      </div>
    );
  }

  // Group by category for readability.
  const grouped: Record<string, Finding[]> = {};
  for (const f of findings) (grouped[f.category] ||= []).push(f);

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([cat, fs]) => (
        <Card key={cat}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm capitalize flex items-center justify-between">
              <span>{cat.replace(/_/g, ' ')}</span>
              <Badge variant="outline" className="text-[10px]">{fs.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {fs.map(f => (
              <div
                key={f.fingerprint}
                className={cn(
                  'border rounded-lg p-3 space-y-1',
                  f.severity === 'critical' ? 'border-red-500/30 bg-red-500/5' :
                  f.severity === 'warning'  ? 'border-amber-500/30 bg-amber-500/5' :
                                              'border-muted',
                )}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{f.severity}</Badge>
                  <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{f.tier === 'safe_auto' ? 'Auto' : 'Approval'}</Badge>
                  <span className="text-[10px] font-mono text-muted-foreground">{f.issueType}</span>
                </div>
                <p className="text-xs font-medium">{f.title}</p>
                <p className="text-[11px] text-muted-foreground">{f.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Mechanic panel: Fix buttons with preview-before-apply ────────────

const AUTO_TIER_TYPES = new Set(['open_past_close']);
// negative_balance / pending_deposit / slow_withdrawal genuinely have
// no safe auto-fixer yet (gateway/ledger investigation needed).
// never_resolved and voided_empty_duplicate get their OWN dedicated
// actions below instead of the generic Preview/Apply flow — neither
// has a single deterministic fix (never_resolved has no oracle source
// of truth to query; voided_empty_duplicate needs a human to look at
// both market rows before picking an outcome), so they're excluded
// from the "no auto-fix" bucket but ALSO excluded from the generic
// Preview button.
const NO_AUTO_FIX_TYPES = new Set(['negative_balance', 'pending_deposit', 'slow_withdrawal']);
const SPECIAL_ACTION_TYPES = new Set(['never_resolved', 'voided_empty_duplicate']);

function MechanicPanel({ findings, onFixed }: { findings: Finding[]; onFixed: () => void }) {
  const { toast } = useToast();
  const [preview, setPreview] = useState<{ finding: Finding; result: any } | null>(null);
  const [busyFingerprint, setBusyFingerprint] = useState<string | null>(null);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [investigate, setInvestigate] = useState<{ finding: Finding; data: any } | null>(null);
  const [investigateLoading, setInvestigateLoading] = useState(false);

  const previewFix = async (finding: Finding) => {
    setBusyFingerprint(finding.fingerprint);
    try {
      const r = await fetch('/api/mechanic/fix', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ finding, dryRun: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setPreview({ finding, result: data.outcome });
      setApplyConfirmed(false);
    } catch (e: any) {
      toast({ title: 'Preview failed', description: e.message, variant: 'destructive' });
    } finally {
      setBusyFingerprint(null);
    }
  };

  const applyFix = async () => {
    if (!preview) return;
    setIsApplying(true);
    try {
      const r = await fetch('/api/mechanic/fix', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ finding: preview.finding, dryRun: false }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (data.ok) {
        toast({ title: 'Fix applied', description: data.outcome?.summary || 'ok' });
      } else {
        toast({ title: 'Fix did not fully succeed', description: data.outcome?.summary || 'see console', variant: 'destructive' });
      }
      setPreview(null);
      onFixed();
    } catch (e: any) {
      toast({ title: 'Apply failed', description: e.message, variant: 'destructive' });
    } finally {
      setIsApplying(false);
    }
  };

  const openInvestigate = async (finding: Finding) => {
    setInvestigateLoading(true);
    setInvestigate({ finding, data: null });
    try {
      const marketId = finding.affectedIds.marketId;
      const r = await fetch(`/api/mechanic/investigate-duplicate?marketId=${marketId}`, {
        credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setInvestigate({ finding, data });
    } catch (e: any) {
      toast({ title: 'Investigate failed', description: e.message, variant: 'destructive' });
      setInvestigate(null);
    } finally {
      setInvestigateLoading(false);
    }
  };

  const dismissFinding = async (finding: Finding, note?: string) => {
    try {
      const r = await fetch('/api/mechanic/acknowledge-alert', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ fingerprint: finding.fingerprint, note }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast({ title: 'Dismissed', description: 'This won’t reappear even though the underlying condition is unchanged.' });
      setInvestigate(null);
      onFixed();
    } catch (e: any) {
      toast({ title: 'Dismiss failed', description: e.message, variant: 'destructive' });
    }
  };

  // Investigate modal's "re-resolve at this outcome" hands off to the
  // SAME preview/apply flow used everywhere else — construct a
  // synthetic Finding pointing re-resolve-voided-market at the market
  // being investigated, with the admin-picked outcome.
  const previewReResolve = (marketId: number, outcomeIndex: number) => {
    const synthetic: Finding = {
      fingerprint: `wrong_void:${marketId}`,
      category: 'settlement',
      issueType: 'wrong_void',
      severity: 'critical',
      tier: 'approval_required',
      title: `Re-resolve market #${marketId} at outcome ${outcomeIndex}`,
      detail: 'Manually chosen outcome from the duplicate-market investigation.',
      affectedIds: { marketId },
      meta: { attemptedOutcome: outcomeIndex },
    };
    setInvestigate(null);
    previewFix(synthetic);
  };

  if (findings.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center space-y-2">
        <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
        <p className="text-sm font-medium">Nothing to fix — the queue is clean.</p>
      </div>
    );
  }

  // Group by category same as Monitor.
  const grouped: Record<string, Finding[]> = {};
  for (const f of findings) (grouped[f.category] ||= []).push(f);

  return (
    <>
      <div className="space-y-4">
        {Object.entries(grouped).map(([cat, fs]) => (
          <Card key={cat}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm capitalize flex items-center justify-between">
                <span>{cat.replace(/_/g, ' ')}</span>
                <Badge variant="outline" className="text-[10px]">{fs.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {fs.map(f => {
                const noAutoFix = NO_AUTO_FIX_TYPES.has(f.issueType) || !f.proposedFix;
                const isAuto = AUTO_TIER_TYPES.has(f.issueType);
                return (
                  <div
                    key={f.fingerprint}
                    className={cn(
                      'border rounded-lg p-3 space-y-2',
                      f.severity === 'critical' ? 'border-red-500/30 bg-red-500/5' :
                      f.severity === 'warning'  ? 'border-amber-500/30 bg-amber-500/5' :
                                                  'border-muted',
                    )}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{f.severity}</Badge>
                      <Badge className={cn('text-[9px] uppercase px-1 py-0', isAuto ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30')}>
                        {isAuto ? 'Safe auto' : 'Approval'}
                      </Badge>
                      <span className="text-[10px] font-mono text-muted-foreground">{f.issueType}</span>
                    </div>
                    <p className="text-xs font-medium">{f.title}</p>
                    <p className="text-[11px] text-muted-foreground">{f.detail}</p>
                    <div className="flex items-center gap-2 pt-1">
                      {f.issueType === 'never_resolved' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1.5"
                          onClick={() => window.open(`/admin/resolve?marketId=${f.affectedIds.marketId}`, '_blank')}
                        >
                          <Wrench className="w-3 h-3" />
                          Resolve now
                        </Button>
                      ) : f.issueType === 'voided_empty_duplicate' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1.5"
                          onClick={() => openInvestigate(f)}
                          disabled={investigateLoading && investigate?.finding.fingerprint === f.fingerprint}
                        >
                          {investigateLoading && investigate?.finding.fingerprint === f.fingerprint
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Eye className="w-3 h-3" />}
                          Investigate
                        </Button>
                      ) : noAutoFix ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground italic">
                          <ShieldAlert className="w-3 h-3" />
                          Manual investigation only — no auto-fix registered.
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1.5"
                          onClick={() => previewFix(f)}
                          disabled={busyFingerprint === f.fingerprint}
                        >
                          {busyFingerprint === f.fingerprint
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Eye className="w-3 h-3" />}
                          Preview fix
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Preview-before-apply dialog */}
      <Dialog open={!!preview} onOpenChange={(v) => { if (!v) { setPreview(null); setApplyConfirmed(false); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Preview fix</DialogTitle>
            <DialogDescription>{preview?.finding.title}</DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-3">
              <div className="bg-muted/20 border rounded-md p-3 text-xs">
                <p className="font-medium mb-1">Plan</p>
                <p className="text-muted-foreground">{preview.result?.summary || 'No plan summary returned.'}</p>
              </div>

              {preview.result?.deltaTngn ? (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-amber-300 font-medium">Money movement</span>
                    <span className="font-mono">₦{Math.round(preview.result.deltaTngn).toLocaleString()}</span>
                  </div>
                  {preview.result.affectedUserIds?.length ? (
                    <p className="text-muted-foreground">
                      {preview.result.affectedUserIds.length} user(s) affected.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <details className="text-[10px] text-muted-foreground">
                <summary className="cursor-pointer">Raw response</summary>
                <pre className="whitespace-pre-wrap mt-2 max-h-40 overflow-auto bg-muted/20 p-2 rounded">
                  {JSON.stringify(preview.result?.details ?? preview.result, null, 2)}
                </pre>
              </details>

              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyConfirmed}
                  onChange={(e) => setApplyConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>I have reviewed the plan above and want to apply this fix. This is irreversible for most fix types.</span>
              </label>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setPreview(null); setApplyConfirmed(false); }} disabled={isApplying}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-500 gap-2"
              onClick={applyFix}
              disabled={!applyConfirmed || isApplying}
            >
              {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
              Apply fix
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Investigate dialog — voided_empty_duplicate. Shows both market
          rows side by side with bet/leg counts so an admin can decide
          in one screen instead of three manual SQL queries, then either
          dismisses (nothing wrong) or picks a real outcome to re-resolve
          the empty-voided market with (handed off to the same preview/
          apply flow above via previewReResolve). */}
      <Dialog open={!!investigate} onOpenChange={(v) => { if (!v) setInvestigate(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Investigate duplicate market</DialogTitle>
            <DialogDescription>{investigate?.finding.title}</DialogDescription>
          </DialogHeader>

          {investigateLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : investigate?.data ? (
            <div className="space-y-3">
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 text-xs">
                <p className="font-medium text-amber-300 mb-1">Recommendation</p>
                <p className="text-muted-foreground">{investigate.data.recommendation}</p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <MarketCompareCard label="Voided-empty (this one)" market={investigate.data.primary} />
                {(investigate.data.duplicates || []).map((d: any) => (
                  <MarketCompareCard key={d.id} label={`Duplicate #${d.id}`} market={d} />
                ))}
              </div>

              <ReResolvePicker
                market={investigate.data.primary}
                onPick={(outcomeIndex) => previewReResolve(investigate.data.primary.id, outcomeIndex)}
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setInvestigate(null)}>Close</Button>
            {investigate && (
              <Button
                variant="outline"
                className="border-emerald-500/30 text-emerald-300 gap-1.5"
                onClick={() => dismissFinding(investigate.finding, 'Reviewed via /ops investigate — no action needed.')}
              >
                <CheckCircle2 className="w-3 h-3" />
                Dismiss — nothing wrong
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MarketCompareCard({ label, market }: { label: string; market: any }) {
  const s = market.stats || {};
  const hasActivity = (s.won || 0) + (s.lost || 0) + (s.active || 0) + (s.refunded || 0) + (s.legs || 0) > 0;
  return (
    <div className={cn('border rounded-lg p-3 text-xs space-y-1.5', hasActivity ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-muted')}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{market.status}</Badge>
      </div>
      <p className="text-muted-foreground line-clamp-2">{market.question}</p>
      <div className="grid grid-cols-5 gap-1 pt-1">
        <DuplicateStat label="Won" value={s.won} />
        <DuplicateStat label="Lost" value={s.lost} />
        <DuplicateStat label="Active" value={s.active} />
        <DuplicateStat label="Refund" value={s.refunded} />
        <DuplicateStat label="Legs" value={s.legs} />
      </div>
      {market.resolved_outcome !== null && market.resolved_outcome !== undefined && (
        <p className="text-[10px] text-muted-foreground">Resolved outcome: {market.resolved_outcome}</p>
      )}
    </div>
  );
}

function DuplicateStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-muted/20 rounded p-1 text-center">
      <p className="text-[8px] uppercase text-muted-foreground">{label}</p>
      <p className="text-[10px] font-semibold tabular-nums">{value ?? 0}</p>
    </div>
  );
}

function ReResolvePicker({ market, onPick }: { market: any; onPick: (outcomeIndex: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const options: string[] = market?.options || [];
  if (options.length === 0) return null;
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <p className="text-xs font-medium">If this market&#39;s bets were wrongly voided, pick the real outcome:</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelected(i)}
            className={cn(
              'text-xs px-2.5 py-1.5 rounded-md border transition-colors',
              selected === i ? 'border-emerald-500 bg-emerald-500/10' : 'border-muted hover:bg-muted/40',
            )}
          >
            {opt}
          </button>
        ))}
      </div>
      <Button
        size="sm"
        className="h-7 text-xs gap-1.5"
        disabled={selected === null}
        onClick={() => selected !== null && onPick(selected)}
      >
        <Eye className="w-3 h-3" />
        Preview re-resolve at this outcome
      </Button>
    </div>
  );
}

// ── Complaints panel: inbox + reply + resolve ────────────────────────

interface ComplaintRow {
  id: string;
  user_id: string;
  user_email?: string;
  user_username?: string;
  reference_code: string;
  type: string;
  description: string | null;
  status: string;
  ai_triage_category: string | null;
  mechanic_attempted: boolean;
  mechanic_result: any;
  admin_response: string | null;
  admin_responded_at: string | null;
  aggregate_child_count: number;
  related_bet_id: string | null;
  related_slip_id: string | null;
  related_market_id: number | null;
  context: any;
  created_at: string;
  resolved_at: string | null;
}

const STATUS_TABS: Array<{ id: string; label: string }> = [
  { id: 'all',                 label: 'All open' },
  { id: 'submitted',           label: 'New' },
  { id: 'monitor_review',      label: 'Monitor' },
  { id: 'admin_working',       label: 'Working' },
  { id: 'mechanic_fixed',      label: 'Auto-fixed' },
  { id: 'resolved',            label: 'Resolved' },
];

function ComplaintsPanel() {
  const { toast } = useToast();
  const [items, setItems] = useState<ComplaintRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<ComplaintRow | null>(null);
  const [reply, setReply] = useState('');
  const [andResolve, setAndResolve] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const openStatuses = ['submitted', 'monitor_review', 'admin_working', 'mechanic_fixed', 'mechanic_attempting'];
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('limit', '100');
      params.set('_', String(Date.now()));
      const r = await fetch(`/api/admin/complaints?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      // For "all open" filter, drop resolved/closed client-side so the
      // server call can stay generic.
      const filtered = statusFilter === 'all'
        ? (data.complaints || []).filter((c: ComplaintRow) => openStatuses.includes(c.status))
        : (data.complaints || []);
      setItems(filtered);
    } catch (e: any) {
      toast({ title: 'Failed to load complaints', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  // Refresh silently every 30s.
  useEffect(() => {
    const iv = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const doAction = async (id: string, action: string, extra: any = {}) => {
    setSending(true);
    try {
      const r = await fetch('/api/admin/complaints', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ complaintId: id, action, ...extra }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const kids = data.replied_to_children ? ` (+${data.replied_to_children} grouped)` : '';
      toast({ title: `Action '${action}' applied${kids}` });
      setSelected(null);
      setReply('');
      setAndResolve(false);
      load();
    } catch (e: any) {
      toast({ title: 'Action failed', description: e.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {STATUS_TABS.map(t => (
          <Button
            key={t.id}
            size="sm"
            variant={statusFilter === t.id ? 'default' : 'outline'}
            onClick={() => setStatusFilter(t.id)}
            className="h-7 text-xs"
          >
            {t.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={load} disabled={loading} className="h-7 text-xs ml-auto">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      {items.length === 0 && !loading ? (
        <div className="border rounded-lg p-8 text-center space-y-2">
          <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
          <p className="text-sm font-medium">No complaints in this view.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => { setSelected(c); setReply(''); setAndResolve(false); }}
              className={cn(
                'w-full text-left border rounded-lg p-3 space-y-1 hover:bg-muted/30 transition-colors',
                c.status === 'submitted' && 'border-blue-500/30 bg-blue-500/5',
                c.status === 'admin_working' && 'border-amber-500/30 bg-amber-500/5',
                c.status === 'resolved' && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono font-bold text-emerald-300">{c.reference_code}</span>
                <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{c.type}</Badge>
                {c.ai_triage_category && (
                  <Badge variant="outline" className="text-[9px] uppercase px-1 py-0 text-blue-300 border-blue-500/30">
                    AI: {c.ai_triage_category}
                  </Badge>
                )}
                <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{c.status.replace(/_/g, ' ')}</Badge>
                {c.aggregate_child_count > 0 && (
                  <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-[9px] px-1 py-0">
                    <UsersIcon className="w-2.5 h-2.5 mr-0.5" /> +{c.aggregate_child_count} more
                  </Badge>
                )}
                {c.mechanic_attempted && (
                  <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-[9px] px-1 py-0">
                    <Wrench className="w-2.5 h-2.5 mr-0.5" /> Mechanic ran
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                <UserIcon className="inline w-3 h-3 mr-1" />
                {c.user_email || c.user_username || c.user_id.slice(0, 8)} · {new Date(c.created_at).toLocaleString()}
              </p>
              {c.description && <p className="text-xs line-clamp-2">{c.description}</p>}
            </button>
          ))}
        </div>
      )}

      {/* Detail / reply drawer */}
      <Dialog open={!!selected} onOpenChange={(v) => { if (!v) setSelected(null); }}>
        <DialogContent className="max-w-2xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageCircle className="w-4 h-4" />
                  {selected.reference_code} · {selected.type}
                </DialogTitle>
                <DialogDescription>
                  {selected.user_email || selected.user_username || selected.user_id.slice(0, 12)}
                  {' · '}
                  {new Date(selected.created_at).toLocaleString()}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                {selected.description && (
                  <div className="bg-muted/20 border rounded-md p-3 text-xs whitespace-pre-wrap">
                    {selected.description}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <MiniStat label="Status" value={selected.status.replace(/_/g, ' ')} />
                  <MiniStat label="AI category" value={selected.ai_triage_category || '—'} />
                  <MiniStat label="Related slip" value={selected.related_slip_id ? selected.related_slip_id.slice(0, 8) + '…' : '—'} />
                  <MiniStat label="Related market" value={selected.related_market_id ? `#${selected.related_market_id}` : '—'} />
                  <MiniStat label="Aggregate group" value={selected.aggregate_child_count > 0 ? `+${selected.aggregate_child_count} more users` : 'solo'} />
                  <MiniStat label="Balance @ submit" value={selected.context?.snapshot ? `₦${(selected.context.snapshot.tngn_balance || 0).toLocaleString()} + ₦${(selected.context.snapshot.bonus_balance || 0).toLocaleString()} bonus` : '—'} />
                </div>

                {selected.mechanic_attempted && selected.mechanic_result && (
                  <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-md p-3 text-[11px] space-y-1">
                    <p className="font-medium text-emerald-300 flex items-center gap-1"><Wrench className="w-3 h-3" /> Mechanic auto-fix result</p>
                    <p className="text-muted-foreground">{selected.mechanic_result?.detail || 'ran'}</p>
                    <p className="text-[10px] text-muted-foreground">outcome: {selected.mechanic_result?.outcomeStatus}</p>
                  </div>
                )}

                {selected.admin_response && (
                  <div className="bg-muted/20 border rounded-md p-3 text-xs">
                    <p className="text-[10px] uppercase text-muted-foreground mb-1">Previous admin reply · {selected.admin_responded_at && new Date(selected.admin_responded_at).toLocaleString()}</p>
                    <p className="whitespace-pre-wrap">{selected.admin_response}</p>
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">Reply to user</label>
                  <Textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="What should we tell this user? (Will notify them in-app.)"
                    className="text-sm min-h-[100px]"
                  />
                  {selected.aggregate_child_count > 0 && (
                    <p className="text-[10px] text-amber-300">
                      This message will also go to the {selected.aggregate_child_count} other user(s) grouped with this complaint.
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={andResolve} onChange={(e) => setAndResolve(e.target.checked)} />
                    Mark resolved after sending
                  </label>
                </div>
              </div>

              <DialogFooter className="flex-wrap gap-2">
                {selected.status !== 'resolved' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => doAction(selected.id, 'resolve')}
                      disabled={sending}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Resolve
                    </Button>
                    <Button
                      className="bg-emerald-600 hover:bg-emerald-500 gap-1.5"
                      size="sm"
                      onClick={() => doAction(selected.id, 'reply', { message: reply.trim(), andResolve })}
                      disabled={sending || !reply.trim()}
                    >
                      {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      Send reply
                    </Button>
                  </>
                )}
                {selected.status === 'resolved' && (
                  <Button variant="outline" size="sm" onClick={() => doAction(selected.id, 'reopen')} disabled={sending}>
                    <RotateCcw className="w-3 h-3 mr-1" /> Reopen
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/20 rounded p-1.5">
      <p className="text-[9px] uppercase text-muted-foreground">{label}</p>
      <p className="text-[11px] font-semibold truncate">{value}</p>
    </div>
  );
}
