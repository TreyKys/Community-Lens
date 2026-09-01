'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, ShieldAlert, RefreshCw, AlertTriangle } from 'lucide-react';

// Open Markets exposure dashboard.
//
// The one number to look at daily is committed worst case: an LMSR market
// maker's maximum possible loss on a market is exactly b·ln(N), known before
// the market opens and independent of how it trades. Summed over live markets,
// that's what the house has on risk.
//
// It's shown against house_reserve deployable, not in isolation, because that
// reserve is SHARED with the locked-odds and multiplier engines — exposure here
// directly shrinks what those two can accept. A panel showing Open Markets
// alone would read healthy while starving the engines carrying the volume.
//
// The levers live on this page rather than a separate one: a dashboard that
// shows a problem and can't act on it sends someone hunting for a psql prompt
// mid-incident.

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export default function OpenMarketsExposurePage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [capInput, setCapInput] = useState('');
  // Same shared key the submit/review/resolve screens use — typed once
  // anywhere on the Open Markets admin pages, remembered everywhere.
  const [adminId, setAdminId] = useState('');

  useEffect(() => {
    fetch('/api/admin/auth').then(r => { if (r.ok) setIsAdmin(true); }).finally(() => setChecking(false));
    try { setAdminId(localStorage.getItem('opinionsng_admin_reviewer_id') || ''); } catch {}
  }, []);

  const login = async () => {
    setLoggingIn(true);
    try {
      const r = await fetch('/api/admin/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (r.ok) { setIsAdmin(true); setSecret(''); }
      else toast({ title: 'Invalid admin secret', variant: 'destructive' });
    } finally { setLoggingIn(false); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/open-markets/exposure', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d);
      setCapInput(String(Math.round(d.totals.capTngn)));
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const act = async (body: any, label: string) => {
    setBusy(label);
    try {
      const r = await fetch('/api/admin/open-markets/exposure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({
        title: label,
        description: body.action === 'sweep_fees'
          ? `${d.marketsSwept} market(s), ${ngn(d.tngnSwept)} moved into the reserve`
          : undefined,
      });
      load();
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  if (checking) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );

  if (!isAdmin) return (
    <div className="max-w-sm mx-auto p-4 pt-16 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="w-4 h-4" /> Admin access
      </div>
      <Input type="password" value={secret} placeholder="Admin secret"
             onChange={e => setSecret(e.target.value)}
             onKeyDown={e => e.key === 'Enter' && login()} />
      <Button className="w-full" onClick={login} disabled={loggingIn || !secret}>
        {loggingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Sign in'}
      </Button>
    </div>
  );

  const t = data?.totals;
  const critical = (data?.health || []).filter((h: any) => h.severity === 'critical');
  const warnings = (data?.health || []).filter((h: any) => h.severity === 'warning');

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Link href="/admin/open-markets"
              className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Review queue
        </Link>
        <button onClick={load} disabled={loading}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div>
        <h1 className="text-xl font-bold">Trading exposure</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Worst case is the most the house can lose across every live market — a fixed figure, not a forecast.
        </p>
      </div>

      {!data ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Health first. A critical invariant failure means a book no longer
              matches its own trade log, and no other number on this page can be
              trusted while that's true. */}
          {(critical.length > 0 || warnings.length > 0) && (
            <Card className={critical.length ? 'border-red-500/40 bg-red-500/[0.05]' : 'border-amber-500/40 bg-amber-500/[0.05]'}>
              <CardContent className="p-4 space-y-2">
                <div className={`flex items-center gap-2 text-xs font-medium ${
                  critical.length ? 'text-red-400' : 'text-amber-300'}`}>
                  <AlertTriangle className="w-4 h-4" />
                  {critical.length ? `${critical.length} critical` : `${warnings.length} warning`}
                </div>
                {[...critical, ...warnings].slice(0, 12).map((h: any, i: number) => (
                  <div key={i} className="text-[11px] text-muted-foreground">
                    <span className="font-mono text-foreground">{h.check_name}</span>
                    {h.market_id && <span className="opacity-60"> · {String(h.market_id).slice(0, 8)}</span>}
                    {' — '}{h.detail}
                    {h.expected !== null && h.expected !== undefined && (
                      <span className="tabular"> (expected {ngn(Number(h.expected))}, actual {ngn(Number(h.actual))})</span>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Card><CardContent className="p-4">
              <p className="text-[10px] text-muted-foreground">Committed worst case</p>
              <p className="text-lg font-semibold tabular">{ngn(t.committedTngn)}</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                {t.liveMarkets} live market{t.liveMarkets === 1 ? '' : 's'}
              </p>
            </CardContent></Card>
            <Card className={t.headroomTngn <= 0 ? 'border-red-500/40' : undefined}>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground">Headroom under cap</p>
                <p className={`text-lg font-semibold tabular ${
                  t.headroomTngn <= 0 ? 'text-red-400' : 'text-emerald-400'}`}>{ngn(t.headroomTngn)}</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {pct(t.capUsedPct)} of {ngn(t.capTngn)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* The cross-engine number. The same pot backs place_bet_locked and
              place_multiplier_slip, so this ratio is what tells you whether
              Open Markets is quietly squeezing the other two. */}
          <Card className={t.reserveUsedPct > 0.8 ? 'border-red-500/40'
                         : t.reserveUsedPct > 0.6 ? 'border-amber-500/40' : undefined}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Share of the house reserve</p>
                <p className={`text-xs tabular ${
                  t.reserveUsedPct > 0.8 ? 'text-red-400'
                  : t.reserveUsedPct > 0.6 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {pct(t.reserveUsedPct)}
                </p>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full rounded-full ${
                  t.reserveUsedPct > 0.8 ? 'bg-red-500'
                  : t.reserveUsedPct > 0.6 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                     style={{ width: `${Math.min(100, t.reserveUsedPct * 100)}%` }} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {ngn(t.committedTngn)} of {ngn(t.deployableTngn)} deployable. This reserve also backs the
                locked-odds and multiplier engines — what sits here is not available to them.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-3 gap-3">
            <Card><CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground">Fees taken</p>
              <p className="text-sm font-semibold tabular">{ngn(t.feesCollectedTngn)}</p>
            </CardContent></Card>
            <Card className={t.feesUnsweptTngn > 0 ? 'border-amber-500/30' : undefined}>
              <CardContent className="p-3 text-center">
                <p className="text-[10px] text-muted-foreground">Not yet swept</p>
                <p className="text-sm font-semibold tabular">{ngn(t.feesUnsweptTngn)}</p>
              </CardContent>
            </Card>
            <Card><CardContent className="p-3 text-center">
              <p className="text-[10px] text-muted-foreground">Owed to creators</p>
              <p className="text-sm font-semibold tabular">{ngn(t.creatorOwedTngn)}</p>
            </CardContent></Card>
          </div>

          {/* Levers */}
          <Card><CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">
                  Trading {data.tradingEnabled ? 'is live' : 'is paused'}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Pausing blocks new trades and new approvals. Existing positions stay exitable —
                  freezing people&rsquo;s money is a bigger incident than most reasons for pausing.
                </p>
              </div>
              <Button size="sm" disabled={!!busy}
                      variant={data.tradingEnabled ? 'outline' : 'default'}
                      className={data.tradingEnabled
                        ? 'border-red-500/40 text-red-400 hover:bg-red-500/10 shrink-0'
                        : 'bg-emerald-600 hover:bg-emerald-500 shrink-0'}
                      onClick={() => act(
                        data.tradingEnabled
                          ? { action: 'pause', reason: 'paused from exposure dashboard' }
                          : { action: 'resume' },
                        data.tradingEnabled ? 'Paused' : 'Resumed')}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : data.tradingEnabled ? 'Pause' : 'Resume'}
              </Button>
            </div>

            {/* Solo operator mode. Four-eyes assumes a second person exists
                to hand a submission to — on a single-admin platform that is
                simply not true, and a control that can never pass is not a
                control. This lets the same person submit-and-approve, or
                resolve-and-confirm, a HOUSE market only (never one with a
                creator earning a fee share), and every time it fires it is
                stamped on the market's own record — visible above as a
                "self-reviewed" badge, never silently indistinguishable from
                real second-person oversight. */}
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <div>
                <p className="text-xs font-medium">
                  Solo operator mode {data.soloOperatorMode ? 'is on' : 'is off'}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {data.soloOperatorMode
                    ? 'You may submit-and-approve, or resolve-and-confirm, your own house markets. Never a market with a creator.'
                    : 'Submitting and reviewing a market always needs two different people, even for house markets.'}
                </p>
                {data.soloOperatorSetAt && (
                  <p className="text-[10px] text-muted-foreground/70">
                    Last changed {new Date(data.soloOperatorSetAt).toLocaleString()}
                  </p>
                )}
              </div>
              <Button size="sm" disabled={!!busy || !adminId.trim()}
                      variant={data.soloOperatorMode ? 'outline' : 'default'}
                      className={data.soloOperatorMode
                        ? 'border-red-500/40 text-red-400 hover:bg-red-500/10 shrink-0'
                        : 'bg-amber-600 hover:bg-amber-500 shrink-0'}
                      onClick={() => act(
                        { action: 'set_solo_mode', enabled: !data.soloOperatorMode, adminId: adminId.trim() },
                        data.soloOperatorMode ? 'Solo mode off' : 'Solo mode on')}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : data.soloOperatorMode ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
            {!adminId.trim() && (
              <p className="text-[10px] text-amber-400">
                Type your user ID on the New Market, review or resolve screen first — this
                button needs it too, and they all share the same one.
              </p>
            )}

            <div className="flex items-end gap-2 pt-2 border-t border-border">
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground">Fleet exposure cap</p>
                <Input value={capInput} onChange={e => setCapInput(e.target.value)}
                       inputMode="numeric" className="text-xs h-8" />
              </div>
              <Button size="sm" variant="outline" disabled={!!busy}
                      onClick={() => act({ action: 'set_cap', maxTotalExposureTngn: Number(capInput) }, 'Cap updated')}>
                Save
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy || t.feesUnsweptTngn <= 0}
                      onClick={() => act({ action: 'sweep_fees' }, 'Fees swept')}>
                {busy === 'Fees swept' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Sweep fees'}
              </Button>
            </div>
          </CardContent></Card>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Live markets</p>
            {data.markets.length === 0 ? (
              <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">
                No live markets.
              </CardContent></Card>
            ) : data.markets.map((m: any) => (
              <Card key={m.id} className={m.status === 'halted' ? 'border-amber-500/40' : undefined}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/open/${m.id}`} className="text-sm font-medium leading-snug hover:underline">
                      {m.question}
                    </Link>
                    <Badge variant="outline" className="text-[9px] uppercase shrink-0">{m.status}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <p className="text-muted-foreground">House risk</p>
                      <p className="tabular">{ngn(m.worstCaseTngn)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Fees taken</p>
                      <p className="tabular">{ngn(m.feesCollectedTngn)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Net if worst case</p>
                      <p className={`tabular ${m.netIfWorstCaseTngn >= 0 ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                        {m.netIfWorstCaseTngn >= 0 ? '+' : '−'}{ngn(Math.abs(m.netIfWorstCaseTngn))}
                      </p>
                    </div>
                  </div>

                  {/* Creator earns nothing until fees clear b·ln(N) — the house
                      recovers its entire maximum exposure first. Shown as
                      progress so it reads as a goal, not a penalty. */}
                  {!m.isHouse && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Creator threshold</span>
                        <span className="tabular">{ngn(m.feesCollectedTngn)} / {ngn(m.thresholdTngn)}</span>
                      </div>
                      <div className="h-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500"
                             style={{ width: `${Math.min(100, m.thresholdProgress * 100)}%` }} />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span>
                      {m.isHouse ? 'House' : 'User'} · b {ngn(m.bTngn)} · {m.outcomeCount} outcomes
                      {m.feesUnsweptTngn > 0 && ` · ${ngn(m.feesUnsweptTngn)} unswept`}
                    </span>
                    {(m.status === 'open' || m.status === 'horizon_window') ? (
                      <button className="text-amber-400 hover:underline" disabled={!!busy}
                              onClick={() => act({ action: 'halt', marketId: m.id, reason: 'halted from dashboard' }, 'Halted')}>
                        Halt
                      </button>
                    ) : m.status === 'halted' ? (
                      <button className="text-emerald-400 hover:underline" disabled={!!busy}
                              onClick={() => act({ action: 'resume_market', marketId: m.id }, 'Resumed')}>
                        Resume
                      </button>
                    ) : null}
                  </div>
                  {m.haltedReason && m.status === 'halted' && (
                    <p className="text-[10px] text-amber-300">Halted: {m.haltedReason}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
