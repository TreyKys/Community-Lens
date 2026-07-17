'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, AlertTriangle, ChevronLeft } from 'lucide-react';
import Link from 'next/link';

// Repair tool for the bonus_proportion regression (migration
// 20260710010000 stamped bonus_proportion = 0 on Multiplier slips placed
// while the bonus-unaware place_multiplier_slip was live). Lists at-risk
// slips with the funding context needed to ascertain the source, and
// applies a "treat as 100% bonus" correction to selected ACTIVE slips
// BEFORE they're resolved, so settlement splits winnings/refunds to
// bonus instead of paying it all as withdrawable cash.
//
// Only active slips are correctable — a settled slip already moved money.

function adminHeaders() {
  return { 'Content-Type': 'application/json' };
}

type Candidate = {
  slipId: string;
  userId: string;
  handle: string;
  status: string;
  slipStakeTngn: number;
  payoutTngn: number;
  placedAt: string;
  currentTngnBalance: number | null;
  currentBonusBalance: number | null;
  lifetimeBonusGranted: number | null;
  likelyBonusFunded: boolean;
  fixable: boolean;
};

export default function BonusRepairPage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [adminInput, setAdminInput] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [since, setSince] = useState('');
  const [includeSettled, setIncludeSettled] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    fetch('/api/admin/auth').then(r => { if (r.ok) setIsAdmin(true); }).finally(() => setIsChecking(false));
  }, []);

  const handleAdminLogin = async () => {
    setIsLoggingIn(true); setLoginError(null);
    try {
      const r = await fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminInput }) });
      if (r.ok) { setIsAdmin(true); setAdminInput(''); } else setLoginError('Invalid admin secret');
    } catch { setLoginError('Network error'); }
    finally { setIsLoggingIn(false); }
  };

  const load = useCallback(async () => {
    setLoading(true); setPreview(null); setSelected(new Set());
    try {
      const params = new URLSearchParams();
      if (since) params.set('since', new Date(since).toISOString());
      if (includeSettled) params.set('includeSettled', 'true');
      const r = await fetch(`/api/admin/slip-funding-audit?${params.toString()}`, { headers: adminHeaders(), credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setCandidates(d.candidates || []);
      setSummary(d.summary || null);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [since, includeSettled, toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const selectAllFixable = () => setSelected(new Set(candidates.filter(c => c.fixable).map(c => c.slipId)));

  const runPreview = async () => {
    if (selected.size === 0) { toast({ title: 'Select at least one slip', variant: 'destructive' }); return; }
    try {
      const r = await fetch('/api/admin/slip-funding-audit', {
        method: 'POST', headers: adminHeaders(), credentials: 'include',
        body: JSON.stringify({ slipIds: Array.from(selected), dryRun: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPreview(d);
    } catch (e: any) { toast({ title: 'Preview failed', description: e.message, variant: 'destructive' }); }
  };

  const apply = async () => {
    if (!preview || (preview.willUpdate || []).length === 0) return;
    setApplying(true);
    try {
      const r = await fetch('/api/admin/slip-funding-audit', {
        method: 'POST', headers: adminHeaders(), credentials: 'include',
        body: JSON.stringify({ slipIds: (preview.willUpdate || []).map((w: any) => w.slipId), dryRun: false }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({ title: `Corrected ${d.appliedCount} slip(s) to 100% bonus`, description: (d.settledSkipped || []).length ? `${d.settledSkipped.length} skipped (already settled).` : undefined });
      setPreview(null);
      load();
    } catch (e: any) { toast({ title: 'Apply failed', description: e.message, variant: 'destructive' }); }
    finally { setApplying(false); }
  };

  const ngn = (n: number | null) => n == null ? '—' : `₦${Math.round(n).toLocaleString()}`;

  if (isChecking) return <div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-80">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4" /> Admin Access</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input type="password" placeholder="Admin secret" value={adminInput} onChange={e => setAdminInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdminLogin()} />
            {loginError && <p className="text-xs text-destructive">{loginError}</p>}
            <Button className="w-full" onClick={handleAdminLogin} disabled={isLoggingIn || !adminInput}>{isLoggingIn ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Verifying…</> : 'Enter'}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-5">
      <div className="flex items-center gap-3 border-b pb-4">
        <Link href="/admin"><Button variant="ghost" size="icon"><ChevronLeft className="w-5 h-5" /></Button></Link>
        <div>
          <h1 className="text-xl font-bold">Slip Bonus Repair</h1>
          <p className="text-xs text-muted-foreground">Fix bonus_proportion on at-risk Multiplier slips before resolving them.</p>
        </div>
      </div>

      <Card className="border-amber-500/30 bg-amber-500/[0.04]">
        <CardContent className="p-3 text-xs text-amber-200/90 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p>These slips recorded <strong>0% bonus</strong> due to a placement regression, so at settlement they&rsquo;d pay 100% to withdrawable cash. Setting a slip to <strong>100% bonus</strong> makes settlement pay 10% cash / 90% bonus instead.</p>
            <p>Only <strong>active</strong> (unresolved) slips can be fixed — settled slips already moved money. The exact original split isn&rsquo;t recoverable; this is a deliberate house-conservative default, so review before applying (a slip that truly used mostly real money would get bonus treatment on the whole payout).</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Placed since (optional)</label>
          <Input type="datetime-local" value={since} onChange={e => setSince(e.target.value)} className="h-9 w-56" />
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer h-9">
          <Checkbox checked={includeSettled} onCheckedChange={v => setIncludeSettled(!!v)} /> Include settled (report only)
        </label>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Refresh'}</Button>
      </div>

      {summary && (
        <p className="text-xs text-muted-foreground">
          {summary.total} candidate slip(s) · {summary.active} active (fixable) · {summary.settled} settled. {summary.note}
        </p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Candidates</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={selectAllFixable}>Select all fixable</Button>
              <Button size="sm" className="h-7 text-xs" onClick={runPreview} disabled={selected.size === 0}>Preview ({selected.size})</Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>
          : candidates.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No at-risk slips found. 🎉</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="p-2 w-8"></th>
                    <th className="p-2 text-left">Slip / User</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-right">Stake</th>
                    <th className="p-2 text-right">Payout</th>
                    <th className="p-2 text-right">Cur. bonus</th>
                    <th className="p-2 text-right">Bonus granted</th>
                    <th className="p-2 text-left">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(c => (
                    <tr key={c.slipId} className="border-b border-border/20">
                      <td className="p-2">
                        <Checkbox checked={selected.has(c.slipId)} disabled={!c.fixable} onCheckedChange={() => toggle(c.slipId)} />
                      </td>
                      <td className="p-2">
                        <div className="font-mono text-[10px] text-muted-foreground">{c.slipId.slice(0, 8)}…</div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">@{c.handle}</span>
                          {c.likelyBonusFunded && <Badge className="text-[9px] px-1 py-0 bg-amber-500/20 text-amber-300 border-amber-500/30">bonus user</Badge>}
                        </div>
                      </td>
                      <td className="p-2">
                        <Badge variant="outline" className={`text-[9px] uppercase px-1 py-0 ${c.status === 'active' ? 'text-emerald-300 border-emerald-500/30' : 'text-muted-foreground'}`}>{c.status}</Badge>
                      </td>
                      <td className="p-2 text-right tabular-nums">{ngn(c.slipStakeTngn)}</td>
                      <td className="p-2 text-right tabular-nums">{ngn(c.payoutTngn)}</td>
                      <td className="p-2 text-right tabular-nums">{ngn(c.currentBonusBalance)}</td>
                      <td className="p-2 text-right tabular-nums">{ngn(c.lifetimeBonusGranted)}</td>
                      <td className="p-2 text-muted-foreground">{new Date(c.placedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {preview && (
        <Card className="border-emerald-500/30">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Preview</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p><strong>{(preview.willUpdate || []).length}</strong> slip(s) will be set to 100% bonus.</p>
            {(preview.settledSkipped || []).length > 0 && <p className="text-amber-300">{preview.settledSkipped.length} skipped — already settled (money already moved).</p>}
            {(preview.alreadyFullBonus || []).length > 0 && <p className="text-muted-foreground">{preview.alreadyFullBonus.length} already at 100% bonus.</p>}
            {(preview.notFound || []).length > 0 && <p className="text-muted-foreground">{preview.notFound.length} not found.</p>}
            <Button className="mt-2 bg-emerald-600 hover:bg-emerald-500" disabled={applying || (preview.willUpdate || []).length === 0} onClick={apply}>
              {applying ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Applying…</> : `Apply 100% bonus to ${(preview.willUpdate || []).length} slip(s)`}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
