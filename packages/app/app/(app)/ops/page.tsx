'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Activity, AlertTriangle, CheckCircle2, RefreshCw, Wrench, MessageSquare, PauseCircle, PlayCircle } from 'lucide-react';
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
      const { data } = await supabase.from('mechanic_state').select('*').eq('id', 1).maybeSingle();
      setMechanicState(data);
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
          {mechanicState?.paused && (
            <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30">
              <PauseCircle className="w-3 h-3 mr-1" /> Auto-fix paused
            </Badge>
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

        {/* Mechanic: same list but with Fix buttons (wired in checkpoint 2) */}
        <TabsContent value="mechanic" className="pt-4">
          <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg">
            Fix dispatcher wires in at checkpoint 2. Findings show under Monitor for now.
          </div>
        </TabsContent>

        {/* Complaints inbox (wired in checkpoints 3–4) */}
        <TabsContent value="complaints" className="pt-4">
          <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg">
            Complaints inbox wires in at checkpoints 3–4.
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'critical' | 'neutral' }) {
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
