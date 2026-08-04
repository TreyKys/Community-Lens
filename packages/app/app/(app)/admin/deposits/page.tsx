'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, RefreshCw, ChevronLeft, AlertTriangle } from 'lucide-react';
import Link from 'next/link';

// Admin view of Squad deposits that are stuck (not completed, not abandoned).
// Per row, "Re-verify" hits /api/squad/refresh (admin-gated) which re-checks
// the charge with Squad and credits it through the atomic settle path if
// confirmed paid. The direct lever for un-sticking a user's deposit now.

type Deposit = {
  reference: string;
  userId: string;
  handle: string;
  amountNgn: number;
  tngnCredited: number | null;
  status: string;
  createdAt: string;
  reviewFlag: boolean;
};

export default function AdminDepositsPage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [adminInput, setAdminInput] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);

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
    setLoading(true);
    try {
      const r = await fetch('/api/admin/stuck-deposits', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDeposits(d.deposits || []);
      setSummary(d.summary || null);
    } catch (e: any) {
      toast({ title: 'Failed to load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const reverify = async (reference: string) => {
    setBusyRef(reference);
    try {
      const r = await fetch('/api/squad/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ reference }),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.status === 'completed') {
        toast({ title: d.fresh ? 'Credited' : 'Already credited', description: `${reference.slice(0, 14)}… — ₦${Math.round(Number(d.tngn_credited || 0)).toLocaleString()}` });
      } else if (d?.status === 'failed') {
        toast({ title: 'Verified failed', description: 'Squad confirms no successful charge.', variant: 'destructive' });
      } else if (d?.status === 'needs_review') {
        toast({ title: 'Needs manual review', description: 'Ambiguous half-state — confirm with Squad before crediting.', variant: 'destructive' });
      } else {
        toast({ title: 'Still processing', description: d.message || 'Squad has not confirmed yet.' });
      }
      load();
    } catch (e: any) {
      toast({ title: 'Re-verify failed', description: e.message, variant: 'destructive' });
    } finally { setBusyRef(null); }
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
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
      <div className="flex items-center gap-3 border-b pb-4">
        <Link href="/admin"><Button variant="ghost" size="icon"><ChevronLeft className="w-5 h-5" /></Button></Link>
        <div>
          <h1 className="text-xl font-bold">Stuck Deposits</h1>
          <p className="text-xs text-muted-foreground">Re-verify a Squad deposit against the gateway and credit it if paid.</p>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><RefreshCw className="w-4 h-4 mr-1" /> Refresh list</>}
        </Button>
      </div>

      {summary && (
        <p className="text-xs text-muted-foreground">
          {summary.total} open deposit(s) · {summary.crediting} crediting (review) · {summary.failedBalanceUpdate} credit-failed · {summary.other} awaiting/other.
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>
          : deposits.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No stuck deposits. 🎉</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="p-2 text-left">Reference / User</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-left">Created</th>
                    <th className="p-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map(d => (
                    <tr key={d.reference} className="border-b border-border/20">
                      <td className="p-2">
                        <div className="font-mono text-[10px] text-muted-foreground break-all">{d.reference}</div>
                        <div className="font-medium">@{d.handle}</div>
                      </td>
                      <td className="p-2 text-right tabular-nums">{ngn(d.amountNgn)}</td>
                      <td className="p-2">
                        <Badge variant="outline" className={`text-[9px] uppercase px-1 py-0 ${d.reviewFlag ? 'text-amber-300 border-amber-500/40' : 'text-muted-foreground'}`}>{d.status}</Badge>
                        {d.reviewFlag && <div className="flex items-center gap-1 text-[9px] text-amber-400 mt-0.5"><AlertTriangle className="w-3 h-3" /> ambiguous — verify first</div>}
                      </td>
                      <td className="p-2 text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</td>
                      <td className="p-2 text-right">
                        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyRef === d.reference} onClick={() => reverify(d.reference)}>
                          {busyRef === d.reference ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><RefreshCw className="w-3.5 h-3.5 mr-1" /> Re-verify</>}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Re-verify calls Squad&rsquo;s own <code>/transaction/verify</code> and credits through the atomic settle path only when Squad confirms the charge succeeded — so a genuinely failed payment is never credited. A <span className="text-amber-400">crediting</span> row is the one ambiguous half-state; confirm with Squad before forcing it.
      </p>
    </div>
  );
}
