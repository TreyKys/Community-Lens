'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2, ChevronLeft, ShieldAlert, RefreshCw, Search, Trash2, Pause, Play,
  Clock, X, Plus, ExternalLink,
} from 'lucide-react';

// Open Markets — Control Panel.
//
// Every other Open Markets admin screen deliberately narrows to the slice it
// needs: the review queue only sees pending_review/revise, /resolve only
// sees what's awaiting a decision, /exposure only sees live markets. None of
// them answers "show me literally everything, in every state, right now" —
// which is the one view an operator needs before trusting this engine with
// real money. This page is that view, plus the two controls that never had
// a home anywhere: deleting a market outright, and rescheduling one that's
// already open.
//
// Deliberately NOT a replacement for the specialised pages — settling or
// voiding a market needs the careful two-person form those pages already
// have, and duplicating that here would be a second, less-tested copy of
// the most dangerous action in the whole engine. This page links to them
// instead of reimplementing them.

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const STATUS_LABEL: Record<string, string> = {
  pending_review: 'Pending review', revise: 'Needs revision', rejected: 'Rejected',
  open: 'Open', horizon_window: 'Horizon window', halted: 'Halted', closed: 'Closed',
  pending_payout: 'Pending payout', resolved: 'Resolved', voided: 'Voided', retired: 'Retired',
};
const STATUS_COLOR: Record<string, string> = {
  pending_review: 'text-sky-400', revise: 'text-amber-400', rejected: 'text-muted-foreground',
  open: 'text-emerald-400', horizon_window: 'text-violet-400', halted: 'text-red-400',
  closed: 'text-amber-400', pending_payout: 'text-amber-400', resolved: 'text-emerald-400',
  voided: 'text-muted-foreground', retired: 'text-muted-foreground',
};

export default function OpenMarketsControlPage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [adminId, setAdminId] = useState('');
  const [capInput, setCapInput] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rescheduleClose, setRescheduleClose] = useState('');
  const [rescheduleHorizon, setRescheduleHorizon] = useState('');
  const [deleteReason, setDeleteReason] = useState('');

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
      const params = new URLSearchParams({ status, q: search });
      const r = await fetch(`/api/admin/open-markets/control?${params}`, { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d);
      setCapInput(String(Math.round(d.config.maxTotalExposureTngn)));
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [status, search, toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const persistAdminId = (v: string) => {
    setAdminId(v);
    try { localStorage.setItem('opinionsng_admin_reviewer_id', v); } catch {}
  };

  // Global levers stay owned by /exposure — this just calls the same
  // endpoint rather than keeping a second copy of pause/halt/sweep logic.
  const actExposure = async (body: any, label: string) => {
    setBusy(label);
    try {
      const r = await fetch('/api/admin/open-markets/exposure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({ title: label });
      load();
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const actControl = async (body: any, label: string) => {
    setBusy(label);
    try {
      const r = await fetch('/api/admin/open-markets/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ ...body, adminId: adminId.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({ title: label });
      setExpanded(null);
      load();
      return true;
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
      return false;
    } finally { setBusy(null); }
  };

  const closeTrading = async (marketId: string) => {
    setBusy('close');
    try {
      const r = await fetch('/api/admin/open-markets/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'close_trading', marketId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({ title: 'Trading closed' });
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

  const cfg = data?.config;
  const counts = data?.statusCounts || {};
  const totalCount = Object.values(counts).reduce((s: number, n: any) => s + Number(n), 0);
  const tabs = ['all', ...(data?.statuses || [])];

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Link href="/admin" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Admin
        </Link>
        <button onClick={load} disabled={loading}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div>
        <h1 className="text-xl font-bold">Trading — control panel</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Every market, in every state, in one place — plus the switches that affect the whole engine.
          Settling and voiding still happen on <Link href="/admin/open-markets/resolve" className="underline">Resolve</Link>,
          on purpose: that form&rsquo;s four-eyes check is the one place a payout decision should be made.
        </p>
      </div>

      {/* Quick links to the specialised pages — nothing here replaces them. */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          { href: '/admin/open-markets', label: 'Review queue' },
          { href: '/admin/open-markets/resolve', label: 'Resolve / void' },
          { href: '/admin/open-markets/exposure', label: 'Exposure & health' },
          { href: '/admin/open-markets/new', label: 'New market' },
        ].map(l => (
          <Link key={l.href} href={l.href}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/30">
            {l.label} <ExternalLink className="w-3 h-3" />
          </Link>
        ))}
      </div>

      <div>
        <p className="text-[10px] text-muted-foreground mb-1">Your admin user ID — needed for solo mode, reschedule and delete</p>
        <Input value={adminId} onChange={e => persistAdminId(e.target.value)} placeholder="your user uuid" className="text-xs h-8" />
      </div>

      {cfg && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Engine-wide</p>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">Trading {cfg.tradingEnabled ? 'is live' : 'is paused'}</p>
                <p className="text-[10px] text-muted-foreground">Blocks new trades and new approvals. Existing positions stay exitable.</p>
              </div>
              <Button size="sm" disabled={!!busy}
                      variant={cfg.tradingEnabled ? 'outline' : 'default'}
                      className={cfg.tradingEnabled ? 'border-red-500/40 text-red-400 hover:bg-red-500/10 shrink-0' : 'bg-emerald-600 hover:bg-emerald-500 shrink-0'}
                      onClick={() => actExposure(
                        cfg.tradingEnabled ? { action: 'pause', reason: 'paused from control panel' } : { action: 'resume' },
                        cfg.tradingEnabled ? 'Paused' : 'Resumed')}>
                {busy === (cfg.tradingEnabled ? 'Paused' : 'Resumed') ? <Loader2 className="w-4 h-4 animate-spin" /> :
                  cfg.tradingEnabled ? <><Pause className="w-3.5 h-3.5 mr-1" />Pause</> : <><Play className="w-3.5 h-3.5 mr-1" />Resume</>}
              </Button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <div>
                <p className="text-xs font-medium">Solo operator mode {cfg.soloOperatorMode ? 'is on' : 'is off'}</p>
                <p className="text-[10px] text-muted-foreground">Lets one admin submit-and-approve, or resolve-and-confirm, a HOUSE market only.</p>
              </div>
              <Button size="sm" disabled={!!busy || !adminId.trim()}
                      variant={cfg.soloOperatorMode ? 'outline' : 'default'}
                      className={cfg.soloOperatorMode ? 'border-red-500/40 text-red-400 hover:bg-red-500/10 shrink-0' : 'bg-amber-600 hover:bg-amber-500 shrink-0'}
                      onClick={() => actExposure({ action: 'set_solo_mode', enabled: !cfg.soloOperatorMode, adminId: adminId.trim() }, cfg.soloOperatorMode ? 'Solo mode off' : 'Solo mode on')}>
                {cfg.soloOperatorMode ? 'Turn off' : 'Turn on'}
              </Button>
            </div>

            <div className="flex items-end gap-2 pt-2 border-t border-border">
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground">Fleet exposure cap</p>
                <Input value={capInput} onChange={e => setCapInput(e.target.value)} inputMode="numeric" className="text-xs h-8" />
              </div>
              <Button size="sm" variant="outline" disabled={!!busy}
                      onClick={() => actExposure({ action: 'set_cap', maxTotalExposureTngn: Number(capInput) }, 'Cap updated')}>
                Save
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy}
                      onClick={() => actExposure({ action: 'sweep_fees' }, 'Fees swept')}>
                Sweep fees
              </Button>
            </div>

            <div className="pt-2 border-t border-border space-y-2">
              <p className="text-[10px] text-muted-foreground">Category allowlist — what a submission or approval will accept</p>
              <div className="flex flex-wrap gap-1.5">
                {cfg.allowedCategories.map((c: string) => (
                  <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border/60 text-[11px]">
                    {c}
                    <button
                      disabled={!!busy || cfg.allowedCategories.length <= 1}
                      title={cfg.allowedCategories.length <= 1 ? 'At least one category must stay allowed' : 'Remove'}
                      onClick={() => actControl({ action: 'set_allowed_categories', categories: cfg.allowedCategories.filter((x: string) => x !== c) }, 'Category removed')}
                      className="text-muted-foreground hover:text-red-400 disabled:opacity-30">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input value={newCategory} onChange={e => setNewCategory(e.target.value)}
                       placeholder="add a category (e.g. music)" className="text-xs h-8" />
                <Button size="sm" variant="outline" disabled={!!busy || !newCategory.trim()}
                        onClick={() => {
                          actControl({ action: 'set_allowed_categories', categories: [...cfg.allowedCategories, newCategory.trim().toLowerCase()] }, 'Category added');
                          setNewCategory('');
                        }}>
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by question…"
                 className="pl-8 text-xs h-9" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tabs.map(s => (
            <button key={s} onClick={() => setStatus(s)}
                    className={`px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
                      status === s ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300' : 'border-border/60 text-muted-foreground hover:border-emerald-500/40'}`}>
              {s === 'all' ? 'All' : STATUS_LABEL[s] || s} · {s === 'all' ? totalCount : (counts[s] || 0)}
            </button>
          ))}
        </div>
      </div>

      {/* Market list */}
      {loading && !data ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (data?.markets || []).length === 0 ? (
        <Card><CardContent className="p-8 text-center text-xs text-muted-foreground">No markets match this filter.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {data.markets.map((m: any) => {
            const isOpen = expanded === m.id;
            return (
              <Card key={m.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/open/${m.id}`} className="text-sm font-medium leading-snug hover:underline">
                      {m.question}
                    </Link>
                    <Badge variant="outline" className={`text-[9px] uppercase shrink-0 ${STATUS_COLOR[m.status] || ''}`}>
                      {STATUS_LABEL[m.status] || m.status}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{m.category}{m.eventTag && ` · ${m.eventTag}`}</span>
                    <span>{m.isHouse ? 'House' : 'User-created'}</span>
                    {m.status !== 'pending_review' && m.status !== 'revise' && m.status !== 'rejected' && (
                      <>
                        <span className="tabular">Vol {ngn(m.volumeTngn)}</span>
                        <span className="tabular">{m.openHolders} holder{m.openHolders === 1 ? '' : 's'}</span>
                        <span className="tabular">Fees {ngn(m.feesCollectedTngn)}</span>
                      </>
                    )}
                    {m.selfReviewed && <span className="text-amber-400">self-reviewed</span>}
                    {m.selfResolved && <span className="text-amber-400">self-resolved</span>}
                  </div>

                  {m.status === 'open' && m.outcomes?.length <= 4 && (
                    <div className="flex flex-wrap gap-2 text-[11px] tabular">
                      {m.outcomes.map((o: string, i: number) => (
                        <span key={i} className="px-1.5 py-0.5 rounded bg-muted/50">{o} {pct(m.prices[i])}</span>
                      ))}
                    </div>
                  )}

                  {m.haltedReason && m.status === 'halted' && (
                    <p className="text-[10px] text-amber-300">Halted: {m.haltedReason}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-[11px] pt-1 border-t border-border/60">
                    {(m.status === 'open' || m.status === 'horizon_window') && (
                      <button className="text-amber-400 hover:underline" disabled={!!busy}
                              onClick={() => actExposure({ action: 'halt', marketId: m.id, reason: 'halted from control panel' }, 'Halted')}>
                        Halt
                      </button>
                    )}
                    {m.status === 'halted' && (
                      <button className="text-emerald-400 hover:underline" disabled={!!busy}
                              onClick={() => actExposure({ action: 'resume_market', marketId: m.id }, 'Resumed')}>
                        Resume
                      </button>
                    )}
                    {m.status === 'open' && (
                      <button className="text-muted-foreground hover:underline" disabled={!!busy}
                              onClick={() => closeTrading(m.id)}>
                        Close trading now
                      </button>
                    )}
                    {(m.status === 'open' || m.status === 'horizon_window') && (
                      <button className="text-muted-foreground hover:underline inline-flex items-center gap-1"
                              onClick={() => { setExpanded(isOpen ? null : m.id); setRescheduleClose(''); setRescheduleHorizon(''); }}>
                        <Clock className="w-3 h-3" /> Reschedule
                      </button>
                    )}
                    {(m.status === 'closed' || m.status === 'pending_payout') && (
                      <Link href="/admin/open-markets/resolve" className="text-emerald-400 hover:underline">
                        Go to resolve →
                      </Link>
                    )}
                    {!m.hasActivity && ['pending_review', 'revise', 'rejected', 'open'].includes(m.status) && (
                      <button className="text-red-400 hover:underline inline-flex items-center gap-1 ml-auto"
                              onClick={() => { setExpanded(isOpen ? null : m.id); setDeleteReason(''); }}>
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    )}
                  </div>

                  {isOpen && (m.status === 'open' || m.status === 'horizon_window') && (
                    <div className="pt-2 border-t border-border/60 space-y-2">
                      <p className="text-[10px] text-muted-foreground">
                        New trading close (required) and review date (optional, must be before it).
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <Input type="datetime-local" value={rescheduleClose} onChange={e => setRescheduleClose(e.target.value)} className="text-xs h-8" />
                        <Input type="datetime-local" value={rescheduleHorizon} onChange={e => setRescheduleHorizon(e.target.value)} className="text-xs h-8" />
                      </div>
                      <Button size="sm" disabled={!!busy || !rescheduleClose || !adminId.trim()}
                              onClick={() => actControl({
                                action: 'reschedule', marketId: m.id,
                                tradingClosesAt: new Date(rescheduleClose).toISOString(),
                                horizonAt: rescheduleHorizon ? new Date(rescheduleHorizon).toISOString() : null,
                              }, 'Rescheduled')}>
                        Save new schedule
                      </Button>
                    </div>
                  )}

                  {isOpen && !m.hasActivity && ['pending_review', 'revise', 'rejected', 'open'].includes(m.status) && (
                    <div className="pt-2 border-t border-border/60 space-y-2">
                      <p className="text-[10px] text-red-400">
                        This erases the market. It never had a trade, so there is nothing to void or refund —
                        but there is also no undo. Say why.
                      </p>
                      <Input value={deleteReason} onChange={e => setDeleteReason(e.target.value)}
                             placeholder="Reason (shown in the audit log)" className="text-xs h-8" />
                      <Button size="sm" variant="outline" disabled={!!busy || deleteReason.trim().length < 5 || !adminId.trim()}
                              className="border-red-500/40 text-red-400 hover:bg-red-500/10"
                              onClick={() => actControl({ action: 'delete', marketId: m.id, reason: deleteReason.trim() }, 'Deleted')}>
                        Permanently delete
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
