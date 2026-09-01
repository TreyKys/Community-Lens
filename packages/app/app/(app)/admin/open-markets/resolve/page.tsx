'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, ShieldAlert, AlertTriangle, RefreshCw } from 'lucide-react';

// Open Markets resolution.
//
// The approval queue opens books; this closes them. Everything here pays real
// money out, so every action previews first from the SAME code path that
// applies it — a preview computed a second way is a preview that can disagree
// with what actually happens.
//
// Four eyes are required and enforced in the database. The confirmer is typed
// in deliberately rather than defaulted: the whole value of the rule is that a
// second person actually looked, and a pre-filled field is a rule that gets
// clicked past.

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

type Market = {
  id: string; question: string; category: string; outcomes: string[]; prices: number[];
  status: string; resolutionSource: string; resolutionDetail: string | null;
  resolvedOutcome: number | null; tradingClosesAt: string | null;
  settlementLockedUntil: string | null; payoutPhase: string; pendingKind: string | null;
  haltedReason: string | null; isHouse: boolean; createdBy: string | null;
  selfReviewed: boolean;
  openHolders: number; openShares: number; unreleasedRows: number;
  awaitingResolution: boolean; overdueClose: boolean; releaseUnlocked: boolean;
  horizonCount: number; disputeWindowHours: number;
};

export default function ResolveOpenMarketsPage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/auth').then(r => { if (r.ok) setIsAdmin(true); }).finally(() => setChecking(false));
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
      const r = await fetch('/api/admin/open-markets/resolve', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMarkets(d.markets || []);
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

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

  // Anything whose cut-off has passed while the book is still live is the most
  // urgent thing on this page: the house is the counterparty to every trade
  // placed after the answer became knowable.
  const overdue = markets.filter(m => m.overdueClose);
  const waiting = markets.filter(m => m.awaitingResolution && !m.overdueClose);
  const stuck   = markets.filter(m => m.status === 'pending_payout' && m.unreleasedRows > 0);
  const rest    = markets.filter(m => !m.awaitingResolution && !m.overdueClose
                                   && !(m.status === 'pending_payout' && m.unreleasedRows > 0));

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
        <h1 className="text-xl font-bold">Resolve trading markets</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Every action previews before it pays. Resolving needs a second person.
        </p>
      </div>

      {overdue.length > 0 && (
        <Card className="border-red-500/40 bg-red-500/[0.05]">
          <CardContent className="p-3 text-xs text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>
              {overdue.length} market{overdue.length === 1 ? ' is' : 's are'} past the trading
              cut-off but still open. Close trading before resolving — the house is the
              counterparty to anything traded in the meantime.
            </span>
          </CardContent>
        </Card>
      )}

      {markets.length === 0 && !loading && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Nothing live or awaiting resolution.
        </CardContent></Card>
      )}

      {[
        { label: 'Past cut-off — close trading', rows: overdue },
        { label: 'Awaiting resolution', rows: waiting },
        { label: 'Payout not finished', rows: stuck },
        { label: 'Live', rows: rest },
      ].filter(g => g.rows.length > 0).map(g => (
        <div key={g.label} className="space-y-2">
          <p className="text-xs text-muted-foreground">{g.label}</p>
          {g.rows.map(m => (
            <MarketCard key={m.id} m={m}
                        expanded={expanded === m.id}
                        onToggle={() => setExpanded(expanded === m.id ? null : m.id)}
                        onDone={() => { load(); }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function MarketCard({ m, expanded, onToggle, onDone }: {
  m: Market; expanded: boolean; onToggle: () => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'settle' | 'void'>('settle');
  const [outcomeIdx, setOutcomeIdx] = useState<number | null>(null);
  // The FIRST of the two required people — the one actually resolving here.
  // This screen already asks for a confirmer's UUID by hand (below); it never
  // asked for the resolver's own, silently depending on a session this admin
  // panel never establishes, with a single shared env var as the only
  // fallback. Same localStorage key as the submit/review screens, so typing
  // it once anywhere on this admin panel covers all three.
  const [resolvedBy, setResolvedBy] = useState('');
  useEffect(() => {
    try { setResolvedBy(localStorage.getItem('opinionsng_admin_reviewer_id') || ''); } catch {}
  }, []);
  const [confirmedBy, setConfirmedBy] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [reason, setReason] = useState('');
  const [voidKind, setVoidKind] = useState<'operational' | 'house_fault'>('operational');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const call = async (body: any, label: string) => {
    setBusy(label);
    try {
      const r = await fetch('/api/admin/open-markets/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ marketId: m.id, ...body }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    } catch (e: any) {
      toast({ title: 'Not applied', description: e.message, variant: 'destructive' });
      return null;
    } finally { setBusy(null); }
  };

  const runPreview = async () => {
    const d = mode === 'settle'
      ? await call({ action: 'settle', outcomeIdx, resolvedBy, confirmedBy, evidenceUrl, dryRun: true }, 'preview')
      : await call({ action: 'void', kind: voidKind, reason, resolvedBy, confirmedBy, dryRun: true }, 'preview');
    if (d) setPreview({ ...d, mode });
  };

  const apply = async () => {
    const d = mode === 'settle'
      ? await call({ action: 'settle', outcomeIdx, resolvedBy, confirmedBy, evidenceUrl, dryRun: false }, 'apply')
      : await call({ action: 'void', kind: voidKind, reason, resolvedBy, confirmedBy, dryRun: false }, 'apply');
    if (d) {
      toast({
        title: mode === 'settle' ? 'Market resolved' : 'Market voided',
        description: d.lockedUntil
          ? `Payouts release after the dispute window closes ${new Date(d.lockedUntil).toLocaleString()}.`
          : undefined,
      });
      setPreview(null); onDone();
    }
  };

  const canPreview = mode === 'settle'
    ? outcomeIdx !== null && confirmedBy.trim().length > 0
    : confirmedBy.trim().length > 0;
  const canApply = preview && (mode === 'settle'
    ? evidenceUrl.trim().length > 0
    : reason.trim().length >= 10);

  return (
    <Card className={m.overdueClose ? 'border-red-500/40'
                   : m.status === 'halted' ? 'border-amber-500/40' : undefined}>
      <CardContent className="p-4 space-y-3">
        <button className="w-full text-left space-y-2" onClick={onToggle}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium leading-snug">{m.question}</p>
            <div className="flex items-center gap-1 shrink-0">
              {m.selfReviewed && (
                <Badge variant="outline" className="text-[9px] uppercase text-amber-400 border-amber-500/40">
                  self-reviewed
                </Badge>
              )}
              <Badge variant="outline" className="text-[9px] uppercase">{m.status}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{m.openHolders} holder{m.openHolders === 1 ? '' : 's'}</span>
            <span>{Math.round(m.openShares).toLocaleString()} shares</span>
            {m.tradingClosesAt && (
              <span className={m.overdueClose ? 'text-red-400' : ''}>
                closes {new Date(m.tradingClosesAt).toLocaleString()}
              </span>
            )}
            {m.unreleasedRows > 0 && (
              <span className="text-amber-400">{m.unreleasedRows} payout(s) unreleased</span>
            )}
          </div>
        </button>

        {expanded && (
          <div className="space-y-4 pt-2 border-t border-border">
            <div className="text-xs space-y-1">
              <p><span className="text-muted-foreground">Settles from:</span> {m.resolutionSource}</p>
              {m.resolutionDetail && <p className="text-muted-foreground">{m.resolutionDetail}</p>}
              <p className="text-muted-foreground">
                Dispute window {m.disputeWindowHours}h · {m.horizonCount} review(s) so far
              </p>
            </div>

            {/* Current prices double as the sanity check: if the market is
                sitting at 97% on one outcome, an admin resolving the other one
                should have to notice that before clicking. */}
            <div className="space-y-1">
              {m.outcomes.map((o, i) => (
                <div key={i} className="flex justify-between text-[11px]">
                  <span>{o}</span>
                  <span className="tabular text-muted-foreground">{pct(m.prices[i] ?? 0)}</span>
                </div>
              ))}
            </div>

            {m.status === 'open' && (
              <div className="space-y-1">
                <Button size="sm" variant="outline" className="w-full" disabled={!!busy}
                        onClick={async () => {
                          const d = await call({ action: 'close_trading' }, 'close');
                          if (d) { toast({ title: 'Trading closed' }); onDone(); }
                        }}>
                  {busy === 'close' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Close trading'}
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  Resolution is only reachable once trading is shut. Otherwise the book is live
                  while the answer is already knowable.
                </p>
              </div>
            )}

            {m.status === 'pending_payout' && (
              <div className="space-y-1">
                <Button size="sm" variant="outline" className="w-full" disabled={!!busy}
                        onClick={async () => {
                          const d = await call({ action: 'release' }, 'release');
                          if (d) {
                            toast({ title: `${d.released} released`,
                                    description: d.finished ? 'All payouts done.' : `${d.remaining} left.` });
                            onDone();
                          }
                        }}>
                  {busy === 'release' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Release payouts now'}
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  {m.releaseUnlocked
                    ? 'The dispute window has passed. The cron does this automatically — use this if it is stuck.'
                    : `Held until ${m.settlementLockedUntil ? new Date(m.settlementLockedUntil).toLocaleString() : 'the dispute window closes'}.`}
                </p>
              </div>
            )}

            {(m.status === 'closed' || m.status === 'halted') && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button className={`p-2 rounded border text-[11px] transition-colors duration-150 ${
                            mode === 'settle' ? 'border-emerald-500 bg-emerald-500/10' : 'border-border'}`}
                          onClick={() => { setMode('settle'); setPreview(null); }}>
                    Resolve — pick the winner
                  </button>
                  <button className={`p-2 rounded border text-[11px] transition-colors duration-150 ${
                            mode === 'void' ? 'border-amber-500 bg-amber-500/10' : 'border-border'}`}
                          onClick={() => { setMode('void'); setPreview(null); }}>
                    Void — give the money back
                  </button>
                </div>

                {mode === 'settle' ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium">Winning outcome</p>
                    {m.outcomes.map((o, i) => (
                      <button key={i}
                              className={`w-full flex justify-between p-2 rounded border text-[11px] transition-colors duration-150 ${
                                outcomeIdx === i ? 'border-emerald-500 bg-emerald-500/10' : 'border-border'}`}
                              onClick={() => { setOutcomeIdx(i); setPreview(null); }}>
                        <span>{o}</span>
                        <span className="tabular text-muted-foreground">
                          market says {pct(m.prices[i] ?? 0)}
                        </span>
                      </button>
                    ))}
                    <div>
                      <p className="text-[10px] text-muted-foreground">Evidence link</p>
                      <Input value={evidenceUrl} onChange={e => setEvidenceUrl(e.target.value)}
                             placeholder="https://…" className="text-xs h-8" />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Required to apply. This is what makes a dispute answerable months from now.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button className={`p-2 rounded border text-[11px] ${
                                voidKind === 'operational' ? 'border-amber-500 bg-amber-500/10' : 'border-border'}`}
                              onClick={() => { setVoidKind('operational'); setPreview(null); }}>
                        <span className="block font-medium">Unanswerable</span>
                        <span className="block text-muted-foreground">split at last prices</span>
                      </button>
                      <button className={`p-2 rounded border text-[11px] ${
                                voidKind === 'house_fault' ? 'border-amber-500 bg-amber-500/10' : 'border-border'}`}
                              onClick={() => { setVoidKind('house_fault'); setPreview(null); }}>
                        <span className="block font-medium">Our mistake</span>
                        <span className="block text-muted-foreground">refund what they paid</span>
                      </button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      If the mistake is ours, nobody should lose money to it — that refunds cost,
                      and the house tops up the difference.
                    </p>
                    <textarea
                      className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[52px]"
                      placeholder="Why is this being voided? Required to apply."
                      value={reason} onChange={e => setReason(e.target.value)} />
                  </div>
                )}

                <div>
                  <p className="text-[10px] text-muted-foreground">
                    Your user ID — the resolver
                  </p>
                  <Input value={resolvedBy}
                         onChange={e => {
                           const v = e.target.value;
                           setResolvedBy(v); setPreview(null);
                           try { localStorage.setItem('opinionsng_admin_reviewer_id', v.trim()); } catch {}
                         }}
                         placeholder="uuid" className="text-xs h-8 font-mono" />
                </div>

                <div>
                  <p className="text-[10px] text-muted-foreground">
                    Confirmer&rsquo;s user ID — must be a different person, and never the creator
                  </p>
                  <Input value={confirmedBy} onChange={e => { setConfirmedBy(e.target.value); setPreview(null); }}
                         placeholder="uuid" className="text-xs h-8 font-mono" />
                </div>

                {preview && (
                  <Card className="border-emerald-500/30 bg-emerald-500/[0.04]">
                    <CardContent className="p-3 space-y-1 text-[11px]">
                      <p className="font-medium text-emerald-300">Preview — nothing has moved</p>
                      <p>{preview.positions} position(s) affected
                        {preview.winners !== undefined && `, ${preview.winners} winner(s)`}</p>
                      {preview.grossTngn !== undefined && (
                        <p>Total to pay out: <span className="tabular">{ngn(preview.grossTngn)}</span></p>
                      )}
                      {preview.housePnlTngn !== undefined && (
                        <p>House {preview.housePnlTngn >= 0 ? 'gains' : 'loses'}{' '}
                          <span className="tabular">{ngn(Math.abs(preview.housePnlTngn))}</span></p>
                      )}
                      {preview.houseTopupTngn > 0 && (
                        <p>House tops up <span className="tabular">{ngn(preview.houseTopupTngn)}</span></p>
                      )}
                    </CardContent>
                  </Card>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <Button size="sm" variant="outline" disabled={!!busy || !canPreview}
                          onClick={runPreview}>
                    {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Preview'}
                  </Button>
                  <Button size="sm" disabled={!!busy || !canApply}
                          className={mode === 'settle'
                            ? 'bg-emerald-600 hover:bg-emerald-500'
                            : 'bg-amber-600 hover:bg-amber-500'}
                          onClick={apply}>
                    {busy === 'apply' ? <Loader2 className="w-4 h-4 animate-spin" />
                      : mode === 'settle' ? 'Resolve' : 'Void'}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Payouts are computed now and released after the {m.disputeWindowHours}h dispute
                  window. Money already in a wallet cannot be taken back, so the wait is the point.
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
