'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, Plus, X, ShieldAlert } from 'lucide-react';

// Admin: create a trading (Open Markets) market.
//
// This existed only as an API endpoint before, which meant the house could not
// put up a trading market without curl — the engine was effectively
// user-submission-only.
//
// It deliberately lands in pending_review like any user submission rather than
// going straight live. A separate "admin creates it open" path would be the
// one route that skips the exposure cap, the trading cut-off check and the
// category allowlist, and it would become the default precisely because it is
// fewer clicks. Liquidity and the go-live decision stay in the review screen,
// where the house-money commitment is shown.

const CATEGORIES = [
  { id: 'sport', label: 'Sport' },
  { id: 'politics', label: 'Politics' },
  { id: 'economy', label: 'Economy & markets' },
  { id: 'entertainment', label: 'Entertainment' },
  { id: 'technology', label: 'Technology' },
  { id: 'weather', label: 'Weather' },
  { id: 'company', label: 'Company milestones' },
];

// Hubs a market can additionally surface on. Mirrors the list in
// /open/create — see lib/sportHubs.ts for why event_tag is free text.
const EVENT_HUBS: Record<string, Array<{ id: string; label: string }>> = {
  entertainment: [{ id: 'bbn', label: 'Big Brother Naija' }],
};

export default function AdminNewOpenMarketPage() {
  const { toast } = useToast();
  const router = useRouter();

  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [kind, setKind] = useState<'binary' | 'multi'>('binary');
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [outcomes, setOutcomes] = useState<string[]>(['Yes', 'No']);
  const [source, setSource] = useState('');
  const [sourceDetail, setSourceDetail] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [horizonAt, setHorizonAt] = useState('');
  const [eventTag, setEventTag] = useState<string | null>(null);
  const [createdBy, setCreatedBy] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/admin/auth').then(r => { if (r.ok) setIsAdmin(true); })
      .finally(() => setChecking(false));
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

  const setKindAndOutcomes = (k: 'binary' | 'multi') => {
    setKind(k);
    setOutcomes(k === 'binary' ? ['Yes', 'No'] : ['', '', '']);
  };

  const cleanOutcomes = outcomes.map(o => o.trim()).filter(Boolean);
  const duplicate = new Set(cleanOutcomes.map(o => o.toLowerCase())).size !== cleanOutcomes.length;

  // Mirrors submit_open_market so a refusal is explained before the round
  // trip. The database still enforces all of it — this is a courtesy, not the
  // gate.
  const problems: string[] = [];
  if (question.trim() && question.trim().length < 15) problems.push('Question is too short to be unambiguous.');
  if (cleanOutcomes.length < 2) problems.push('Needs at least two outcomes.');
  if (cleanOutcomes.length > 8) problems.push('Maximum eight outcomes.');
  if (duplicate) problems.push('Two outcomes are the same.');
  if (source.trim() && source.trim().length < 3) problems.push('Name the resolution source properly.');
  if (closesAt && new Date(closesAt).getTime() <= Date.now()) problems.push('Closing time is in the past.');
  if (horizonAt && closesAt && new Date(horizonAt) >= new Date(closesAt)) {
    problems.push('A review date must fall before trading closes.');
  }

  const ready = question.trim().length >= 15 && category && cleanOutcomes.length >= 2
    && !duplicate && source.trim().length >= 3 && problems.length === 0;

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await fetch('/api/admin/open-markets/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          question: question.trim(),
          description: description.trim() || null,
          category,
          outcomes: cleanOutcomes,
          resolutionSource: source.trim(),
          resolutionDetail: sourceDetail.trim() || null,
          tradingClosesAt: closesAt ? new Date(closesAt).toISOString() : null,
          horizonAt: horizonAt ? new Date(horizonAt).toISOString() : null,
          eventTag,
          createdBy: createdBy.trim() || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast({
        title: 'Submitted for review',
        description: 'Approve it in the queue to set liquidity and open the book.',
      });
      router.push('/admin/open-markets');
    } catch (e: any) {
      toast({ title: 'Not created', description: e.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
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

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4 pb-24">
      <Link href="/admin/open-markets"
            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="w-4 h-4" /> Review queue
      </Link>

      <div>
        <h1 className="text-xl font-bold">New trading market</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Price moves as people trade, and holders can sell before it resolves.
          For a fixed-price market, use Create Market on the main admin page instead.
        </p>
      </div>

      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="p-4 space-y-1">
          <p className="text-xs font-medium text-emerald-300">This lands in the review queue</p>
          <p className="text-[11px] text-muted-foreground">
            It will not be live yet. Liquidity tier, the exposure check and the go-live
            decision all happen at approval — that is where the house-money commitment is
            shown, so it stays in one place.
          </p>
        </CardContent>
      </Card>

      <Card><CardContent className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <button className={`p-3 rounded border text-xs transition-colors duration-150 ${
                    kind === 'binary' ? 'border-emerald-500 bg-emerald-500/10' : 'border-border'}`}
                  onClick={() => setKindAndOutcomes('binary')}>
            <span className="block font-medium">Yes or no</span>
            <span className="block text-[10px] text-muted-foreground">Will X happen?</span>
          </button>
          <button className={`p-3 rounded border text-xs transition-colors duration-150 ${
                    kind === 'multi' ? 'border-emerald-500 bg-emerald-500/10' : 'border-border'}`}
                  onClick={() => setKindAndOutcomes('multi')}>
            <span className="block font-medium">Several options</span>
            <span className="block text-[10px] text-muted-foreground">Who or which one?</span>
          </button>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Question</p>
          <textarea
            className="w-full text-sm bg-transparent border border-border rounded p-2 min-h-[64px]"
            placeholder="Will the CBN hold the MPR at its next meeting?"
            value={question} onChange={e => setQuestion(e.target.value)} maxLength={200} />
          <p className="text-[10px] text-muted-foreground">
            At least 15 characters. Two strangers reading it should agree on the answer afterwards.
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Outcomes</p>
          {outcomes.map((o, i) => (
            <div key={i} className="flex gap-2">
              <Input value={o} className="text-sm h-9"
                     placeholder={`Option ${i + 1}`}
                     disabled={kind === 'binary'}
                     onChange={e => {
                       const next = [...outcomes]; next[i] = e.target.value; setOutcomes(next);
                     }} />
              {kind === 'multi' && outcomes.length > 2 && (
                <button className="text-muted-foreground hover:text-red-400 px-2"
                        onClick={() => setOutcomes(outcomes.filter((_, x) => x !== i))}>
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
          {kind === 'multi' && outcomes.length < 8 && (
            <button className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:underline"
                    onClick={() => setOutcomes([...outcomes, ''])}>
              <Plus className="w-3 h-3" /> Add another
            </button>
          )}
          <p className="text-[10px] text-muted-foreground">
            Exactly one must end up true — include &ldquo;none of these&rdquo; if that is possible.
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Category</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map(c => (
              <button key={c.id}
                      className={`px-3 py-1.5 rounded-full border text-[11px] transition-colors duration-150 ${
                        category === c.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-border'}`}
                      onClick={() => { setCategory(c.id); setEventTag(null); }}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {category && EVENT_HUBS[category] && (
          <div className="space-y-1">
            <p className="text-xs font-medium">
              Also feature on a hub <span className="text-muted-foreground font-normal">(optional)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {EVENT_HUBS[category].map(h => (
                <button key={h.id}
                        className={`px-3 py-1.5 rounded-full border text-[11px] transition-colors duration-150 ${
                          eventTag === h.id ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-300' : 'border-border'}`}
                        onClick={() => setEventTag(eventTag === h.id ? null : h.id)}>
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <p className="text-xs font-medium">Resolution source</p>
          <Input value={source} onChange={e => setSource(e.target.value)}
                 className="text-sm h-9"
                 placeholder="e.g. CBN website, NBS, Africa Magic" />
          <textarea
            className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[52px] mt-1"
            placeholder="Edge cases — e.g. 'If the meeting is postponed, this voids.' (optional)"
            value={sourceDetail} onChange={e => setSourceDetail(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs font-medium">Trading closes</p>
            <Input type="datetime-local" value={closesAt}
                   onChange={e => setClosesAt(e.target.value)} className="text-xs h-9" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Must be before the answer is public. Can also be set at approval.
            </p>
          </div>
          <div>
            <p className="text-xs font-medium">Review date</p>
            <Input type="datetime-local" value={horizonAt}
                   onChange={e => setHorizonAt(e.target.value)} className="text-xs h-9" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Optional checkpoint where holders can cash out early.
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Extra context <span className="text-muted-foreground font-normal">(optional)</span></p>
          <textarea
            className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[52px]"
            value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div className="space-y-1 pt-2 border-t border-border">
          <p className="text-xs font-medium">
            Attribute to a creator <span className="text-muted-foreground font-normal">(optional)</span>
          </p>
          <Input value={createdBy} onChange={e => setCreatedBy(e.target.value)}
                 className="text-xs h-8 font-mono" placeholder="user uuid — leave blank for a house market" />
          <p className="text-[10px] text-muted-foreground">
            Blank means a HOUSE market: no creator, so no fee share accrues and anyone can
            trade it. Naming someone gives them the 25% creator share — and then neither they
            nor you-as-them can review it, and they cannot trade it themselves.
          </p>
        </div>
      </CardContent></Card>

      {problems.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/[0.05]">
          <CardContent className="p-3 space-y-1">
            {problems.map(p => <p key={p} className="text-[11px] text-amber-200">{p}</p>)}
          </CardContent>
        </Card>
      )}

      <Button className="w-full bg-emerald-600 hover:bg-emerald-500"
              disabled={!ready || submitting} onClick={submit}>
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send to review queue'}
      </Button>
    </div>
  );
}
