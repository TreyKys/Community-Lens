'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, ShieldAlert, BarChart3 } from 'lucide-react';

// Open Markets review queue.
//
// This screen is the primary anti-abuse control for the whole engine. Once a
// market is open the house is the counterparty to every trade on it, and every
// remaining defence is damage limitation — so the gate is here, before any
// money is committed.
//
// The rubric is rendered as a form rather than kept in a document because a
// document gets skipped at 2am on market number forty. Every check that CAN be
// a machine check already is one, inside review_open_market: the score floor,
// the hard gates, the exposure cap, four eyes, and that the book is untouched.
// This form exists to make the human judgement — reading the question and
// deciding what it's really asking — quick and consistent.

const HARD_GATES = [
  { id: 'H1', label: 'Names or targets a private individual' },
  { id: 'H2', label: 'Death, injury, violence, or illegal acts' },
  { id: 'H3', label: 'The creator or a small group can cause the outcome' },
  { id: 'H4', label: 'No public, verifiable resolution source exists' },
  { id: 'H5', label: 'Outcome is already known' },
  { id: 'H6', label: 'Category outside the allowlist' },
];

const DIMENSIONS = [
  { id: 'resolution_clarity',   label: 'Resolution clarity',   hint: '0 opinion · 1 mostly clear · 2 any reader agrees' },
  { id: 'source_quality',       label: 'Source quality',       hint: '0 none · 1 weak · 2 public + authoritative' },
  { id: 'horizon_realism',      label: 'Horizon realism',      hint: '0 no end · 1 vague · 2 concrete review date' },
  { id: 'ambiguity_resistance', label: 'Ambiguity resistance', hint: '0 many readings · 1 thin edges · 2 edges handled' },
  { id: 'audience_interest',    label: 'Audience interest',    hint: '0 niche · 1 some · 2 broad Nigerian interest' },
  { id: 'category_fit',         label: 'Category fit',         hint: '0 borderline · 1 acceptable · 2 squarely in' },
];

const TIERS = [
  { id: 'starter',  label: 'Starter',  b: 10000 },
  { id: 'standard', label: 'Standard', b: 25000 },
  { id: 'featured', label: 'Featured', b: 75000 },
];

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;

type Submission = {
  id: string; question: string; description: string | null; category: string;
  outcomes: string[]; resolutionSource: string; resolutionDetail: string | null;
  horizonAt: string | null; tradingClosesAt: string | null; status: string;
  createdAt: string;
  creator: { id: string | null; handle: string | null; email: string | null;
             resolved: number; rejected: number; voided: number; disputes: number };
  history: Array<{ decision: string; score: number | null; notes: string | null; created_at: string }>;
};

export default function OpenMarketsReviewPage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [loading, setLoading] = useState(false);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [exposure, setExposure] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
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
      const r = await fetch('/api/admin/open-markets/queue', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSubs(d.submissions || []); setExposure(d.exposure); setConfig(d.config);
    } catch (e: any) {
      toast({ title: 'Could not load queue', description: e.message, variant: 'destructive' });
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

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Link href="/admin" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Admin
        </Link>
        <Link href="/admin/open-markets/exposure"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <BarChart3 className="w-3.5 h-3.5" /> Exposure
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-bold">Open Markets review</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Approving commits house money. Everything below the fold is the rubric.
        </p>
      </div>

      {/* Budget sits next to the queue because approving is what spends it.
          A reviewer who can't see the headroom approves into the cap and gets
          a refusal they have no way to interpret. */}
      {exposure && (
        <Card className={exposure.headroomTngn <= 0 ? 'border-red-500/40' : undefined}>
          <CardContent className="p-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground">Committed</p>
              <p className="text-sm font-semibold tabular">{ngn(exposure.committedTngn)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Cap</p>
              <p className="text-sm font-semibold tabular">{ngn(exposure.capTngn)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Headroom</p>
              <p className={`text-sm font-semibold tabular ${
                exposure.headroomTngn <= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {ngn(exposure.headroomTngn)}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {config && config.trading_enabled === false && (
        <Card className="border-amber-500/40 bg-amber-500/[0.05]">
          <CardContent className="p-3 text-xs text-amber-200">
            Open Markets are paused ({config.disabled_reason || 'no reason given'}). Approvals are blocked until you resume.
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : subs.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          Nothing waiting for review.
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {subs.map(s => (
            <SubmissionCard
              key={s.id} sub={s}
              expanded={expanded === s.id}
              onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
              headroom={exposure?.headroomTngn ?? Infinity}
              onDone={() => { setExpanded(null); load(); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubmissionCard({ sub, expanded, onToggle, headroom, onDone }: {
  sub: Submission; expanded: boolean; onToggle: () => void;
  headroom: number; onDone: () => void;
}) {
  const { toast } = useToast();
  const [scores, setScores] = useState<Record<string, number>>({});
  const [gate, setGate] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [tier, setTier] = useState('starter');
  const [closesAt, setClosesAt] = useState(
    sub.tradingClosesAt ? sub.tradingClosesAt.slice(0, 16) : '');
  const [horizonAt, setHorizonAt] = useState(
    sub.horizonAt ? sub.horizonAt.slice(0, 16) : '');
  const [busy, setBusy] = useState<string | null>(null);

  const total = DIMENSIONS.reduce((t, d) => t + (scores[d.id] ?? 0), 0);
  const allScored = DIMENSIONS.every(d => scores[d.id] !== undefined);
  const tierB = TIERS.find(t => t.id === tier)?.b ?? 10000;
  // b·ln(N) — the house's maximum loss on this market, and also the exact
  // threshold the creator must clear before earning anything.
  const worstCase = tierB * Math.log(Math.max(sub.outcomes.length, 2));
  const overCap = worstCase > headroom;

  const submit = async (decision: 'approve' | 'revise' | 'reject') => {
    setBusy(decision);
    try {
      const r = await fetch('/api/admin/open-markets/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          marketId: sub.id, decision, scores, hardGate: gate, notes,
          ...(decision === 'approve' ? {
            tier,
            tradingClosesAt: closesAt ? new Date(closesAt).toISOString() : null,
            horizonAt: horizonAt ? new Date(horizonAt).toISOString() : null,
          } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({
        title: decision === 'approve' ? 'Market opened'
             : decision === 'revise' ? 'Sent back for revision' : 'Rejected',
        description: decision === 'approve'
          ? `Liquidity ${ngn(d.bTngn)} · house risk ${ngn(d.worstCaseTngn)} · creator threshold ${ngn(d.thresholdTngn)}`
          : undefined,
      });
      onDone();
    } catch (e: any) {
      toast({ title: 'Not applied', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const c = sub.creator;
  // Track record, shown inline. "Has this person had a market resolve cleanly"
  // is the most useful single fact a reviewer can have, and it never gets
  // looked up if it takes a separate query.
  const risky = c.voided > 0 || c.disputes > 0 || c.rejected >= 2;

  return (
    <Card className={expanded ? 'border-emerald-500/30' : undefined}>
      <CardContent className="p-4 space-y-3">
        <button className="w-full text-left space-y-2" onClick={onToggle}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium leading-snug">{sub.question}</p>
            <Badge variant="outline" className="text-[9px] uppercase shrink-0">{sub.status}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="uppercase">{sub.category}</span>
            <span>{sub.outcomes.length} outcomes</span>
            <span>{c.handle ? `@${c.handle}` : 'House'}</span>
            {c.id && (
              <span className={risky ? 'text-amber-400' : ''}>
                {c.resolved} resolved · {c.rejected} rejected
                {c.voided > 0 && ` · ${c.voided} voided`}
                {c.disputes > 0 && ` · ${c.disputes} disputed`}
              </span>
            )}
          </div>
        </button>

        {expanded && (
          <div className="space-y-4 pt-2 border-t border-border">
            <div className="space-y-1 text-xs">
              {sub.description && <p className="text-muted-foreground">{sub.description}</p>}
              <p><span className="text-muted-foreground">Outcomes:</span> {sub.outcomes.join(' · ')}</p>
              <p><span className="text-muted-foreground">Settles from:</span> {sub.resolutionSource}</p>
              {sub.resolutionDetail && (
                <p className="text-muted-foreground">{sub.resolutionDetail}</p>
              )}
            </div>

            {sub.history.length > 0 && (
              <div className="text-[11px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Previously</p>
                {sub.history.map((h, i) => (
                  <p key={i}>
                    {h.decision}{h.score !== null ? ` (${h.score}/12)` : ''} — {h.notes || 'no notes'}
                  </p>
                ))}
              </div>
            )}

            {/* Hard gates first. Any one of these is an automatic reject, and
                putting them above the scorecard stops a reviewer scoring a
                market that should never have been scored at all. */}
            <div className="space-y-2">
              <p className="text-xs font-medium">Hard gates — any one is an automatic reject</p>
              <div className="space-y-1">
                {HARD_GATES.map(g => (
                  <label key={g.id} className="flex items-start gap-2 text-[11px] cursor-pointer">
                    <input type="radio" name={`gate-${sub.id}`} className="mt-0.5"
                           checked={gate === g.id}
                           onChange={() => setGate(gate === g.id ? null : g.id)} />
                    <span className={gate === g.id ? 'text-red-400' : 'text-muted-foreground'}>
                      <span className="font-mono">{g.id}</span> {g.label}
                    </span>
                  </label>
                ))}
                {gate && (
                  <button className="text-[11px] text-muted-foreground underline"
                          onClick={() => setGate(null)}>Clear gate</button>
                )}
              </div>
            </div>

            {!gate && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">Score</p>
                  <p className={`text-xs tabular ${
                    total >= 10 ? 'text-emerald-400' : total >= 7 ? 'text-amber-400' : 'text-red-400'}`}>
                    {total}/12 · {total >= 10 ? 'approve' : total >= 7 ? 'revise' : 'reject'}
                  </p>
                </div>
                {DIMENSIONS.map(d => (
                  <div key={d.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px]">{d.label}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{d.hint}</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {[0, 1, 2].map(v => (
                        <button key={v}
                                className={`w-7 h-7 rounded text-[11px] border transition-colors duration-150 ${
                                  scores[d.id] === v
                                    ? 'bg-emerald-600 border-emerald-500 text-white'
                                    : 'border-border text-muted-foreground hover:border-emerald-500/40'}`}
                                onClick={() => setScores({ ...scores, [d.id]: v })}>
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <p className="text-xs font-medium">Notes</p>
              <textarea
                className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[60px]"
                placeholder="Required when sending back for revision — say exactly what to change."
                value={notes} onChange={e => setNotes(e.target.value)} />
            </div>

            {!gate && total >= 10 && (
              <div className="space-y-3 pt-2 border-t border-border">
                <div className="space-y-1">
                  <p className="text-xs font-medium">Liquidity tier</p>
                  <div className="grid grid-cols-3 gap-2">
                    {TIERS.map(t => (
                      <button key={t.id}
                              className={`p-2 rounded border text-[11px] transition-colors duration-150 ${
                                tier === t.id
                                  ? 'border-emerald-500 bg-emerald-500/10'
                                  : 'border-border hover:border-emerald-500/40'}`}
                              onClick={() => setTier(t.id)}>
                        <span className="block font-medium">{t.label}</span>
                        <span className="block text-muted-foreground tabular">{ngn(t.b)}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    House risk on this market: <span className="tabular">{ngn(worstCase)}</span> — the most it can
                    lose, whatever happens. The creator earns nothing until fees pass that same figure.
                  </p>
                  {overCap && (
                    <p className="text-[10px] text-red-400">
                      Over the remaining headroom ({ngn(headroom)}). Resolve a market or raise the cap first.
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] text-muted-foreground">Trading stops</p>
                    <Input type="datetime-local" value={closesAt}
                           onChange={e => setClosesAt(e.target.value)} className="text-xs h-8" />
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Review date (optional)</p>
                    <Input type="datetime-local" value={horizonAt}
                           onChange={e => setHorizonAt(e.target.value)} className="text-xs h-8" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Trading must stop before the answer becomes public, or the house is the counterparty to
                  every informed trade in between. A review date must fall before it.
                </p>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={!!busy}
                      className="border-red-500/40 text-red-400 hover:bg-red-500/10"
                      onClick={() => submit('reject')}>
                {busy === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Reject'}
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy || notes.trim().length < 10}
                      onClick={() => submit('revise')}>
                {busy === 'revise' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Revise'}
              </Button>
              <Button size="sm"
                      className="bg-emerald-600 hover:bg-emerald-500"
                      disabled={!!busy || !!gate || !allScored || total < 10 || overCap || !closesAt}
                      onClick={() => submit('approve')}>
                {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Approve'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
