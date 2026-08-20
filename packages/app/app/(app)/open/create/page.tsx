'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, Plus, X, Check } from 'lucide-react';

// Create a market.
//
// Written as a guided form rather than a blank one because the difference
// between a market that gets approved and one that gets rejected is almost
// always specificity, and a person filling in an empty box has no idea what
// "specific enough" means. So the rules are shown as they become relevant,
// and the reasons a market gets turned down are stated up front rather than
// discovered after a day of waiting.
//
// Nothing here decides liquidity or the trading cut-off. Those are set at
// approval, because choosing your own liquidity is choosing the house's
// maximum loss on your market.

const CATEGORIES = [
  { id: 'sport',         label: 'Sport' },
  { id: 'politics',      label: 'Politics' },
  { id: 'economy',       label: 'Economy & markets' },
  { id: 'entertainment', label: 'Entertainment' },
  { id: 'technology',    label: 'Technology' },
  { id: 'weather',       label: 'Weather' },
  { id: 'company',       label: 'Company milestones' },
];

const REJECT_REASONS = [
  'Anything about a private individual',
  'Death, injury, violence or crime',
  'Anything you or your friends could cause to happen',
  'No public source that can settle it',
  'Something already decided',
];

// Themed hub pages a market can land on, on top of the general /open browse
// list — /bbn today, more as they get built. Adding the next one is one
// entry here plus a hub page, not a schema change: event_tag is a free-text
// column precisely so this list can grow without a migration.
const EVENT_HUBS: Record<string, Array<{ id: string; label: string }>> = {
  entertainment: [{ id: 'bbn', label: 'Big Brother Naija' }],
};

export default function CreateOpenMarketPage() {
  const { toast } = useToast();
  const router = useRouter();

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
  const [submitting, setSubmitting] = useState(false);

  const setKindAndOutcomes = (k: 'binary' | 'multi') => {
    setKind(k);
    setOutcomes(k === 'binary' ? ['Yes', 'No'] : ['', '', '']);
  };

  const cleanOutcomes = outcomes.map(o => o.trim()).filter(Boolean);
  const duplicate = new Set(cleanOutcomes.map(o => o.toLowerCase())).size !== cleanOutcomes.length;

  // Mirrors submit_open_market so the form can explain a refusal before the
  // round trip. The database still enforces all of it — this is a courtesy,
  // not the gate.
  const problems: string[] = [];
  if (question.trim().length > 0 && question.trim().length < 15) {
    problems.push('The question needs to be longer and more specific.');
  }
  if (cleanOutcomes.length < 2) problems.push('Give at least two outcomes.');
  if (duplicate) problems.push('Two outcomes are the same.');
  if (source.trim().length > 0 && source.trim().length < 3) {
    problems.push('Name the source properly.');
  }
  if (closesAt && new Date(closesAt).getTime() <= Date.now()) {
    problems.push('The closing time is in the past.');
  }
  if (horizonAt && closesAt && new Date(horizonAt) >= new Date(closesAt)) {
    problems.push('A review date has to come before trading stops.');
  }

  const ready = question.trim().length >= 15 && category && cleanOutcomes.length >= 2
    && !duplicate && source.trim().length >= 3 && problems.length === 0;

  const submit = async () => {
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in first');
      const r = await fetch('/api/open-markets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
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
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not submit');
      toast({
        title: 'Sent for review',
        description: 'We usually decide within a day. You will get a notification.',
      });
      router.push('/open/creator');
    } catch (e: any) {
      toast({ title: 'Not submitted', description: e.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4 pb-24">
      <Link href="/open" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="w-4 h-4" /> Open markets
      </Link>

      <div>
        <h1 className="text-xl font-bold">Create a market</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Ask something people will argue about. If it gets busy enough, you earn a
          share of the fees.
        </p>
      </div>

      {/* The earning rule, stated before they invest effort rather than after.
          Hiding it would make the first payout feel arbitrary and the first
          non-payout feel like a con. */}
      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="p-4 space-y-1">
          <p className="text-xs font-medium text-emerald-300">How earning works</p>
          <p className="text-[11px] text-muted-foreground">
            We put up the money that makes your market tradeable from the very first
            person. You earn <span className="text-foreground">25% of the fees</span> once
            your market has produced enough of them to cover what we put up. Quiet
            markets earn nothing — busy ones keep paying for as long as they trade.
          </p>
        </CardContent>
      </Card>

      <Card><CardContent className="p-4 space-y-2">
        <p className="text-xs font-medium">What gets turned down</p>
        <ul className="space-y-1">
          {REJECT_REASONS.map(r => (
            <li key={r} className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <X className="w-3 h-3 mt-0.5 text-red-400 shrink-0" /> {r}
            </li>
          ))}
        </ul>
      </CardContent></Card>

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
          <p className="text-xs font-medium">The question</p>
          <textarea
            className="w-full text-sm bg-transparent border border-border rounded p-2 min-h-[64px]"
            placeholder={kind === 'binary'
              ? 'Will the Super Eagles win their next AFCON group match?'
              : 'Which team will finish top of the NPFL this season?'}
            value={question} onChange={e => setQuestion(e.target.value)} maxLength={200} />
          <p className="text-[10px] text-muted-foreground">
            Write it so two strangers reading it would agree on the answer afterwards.
            &ldquo;Will fuel be expensive?&rdquo; is an argument. &ldquo;Will petrol pass ₦1,200/litre
            before December?&rdquo; is a market.
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
          {kind === 'multi' && (
            <p className="text-[10px] text-muted-foreground">
              Cover every possibility — including &ldquo;none of these&rdquo; if that could happen.
              Exactly one option has to end up true.
            </p>
          )}
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
              Feature this on a hub page <span className="text-muted-foreground font-normal">(optional)</span>
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
            <p className="text-[10px] text-muted-foreground">
              Puts your market on that page too, not instead of the general Open Markets list.
            </p>
          </div>
        )}

        <div className="space-y-1">
          <p className="text-xs font-medium">Who decides the answer?</p>
          <Input value={source} onChange={e => setSource(e.target.value)}
                 className="text-sm h-9"
                 placeholder="e.g. the NPFL official website, CBN, NBS, BBC Sport" />
          <p className="text-[10px] text-muted-foreground">
            It has to be public and checkable by anyone. This is the most common reason a
            market gets sent back.
          </p>
          <textarea
            className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[52px] mt-1"
            placeholder="Anything tricky? e.g. 'If the match is abandoned, it counts as no result.' (optional)"
            value={sourceDetail} onChange={e => setSourceDetail(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-xs font-medium">Trading stops</p>
            <Input type="datetime-local" value={closesAt}
                   onChange={e => setClosesAt(e.target.value)} className="text-xs h-9" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Before the answer becomes public.
            </p>
          </div>
          <div>
            <p className="text-xs font-medium">Review date</p>
            <Input type="datetime-local" value={horizonAt}
                   onChange={e => setHorizonAt(e.target.value)} className="text-xs h-9" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Optional. A checkpoint where holders can take their money out early.
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">Extra context <span className="text-muted-foreground font-normal">(optional)</span></p>
          <textarea
            className="w-full text-xs bg-transparent border border-border rounded p-2 min-h-[52px]"
            placeholder="Anything that helps people understand what they're predicting."
            value={description} onChange={e => setDescription(e.target.value)} />
        </div>
      </CardContent></Card>

      {problems.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/[0.05]">
          <CardContent className="p-3 space-y-1">
            {problems.map(p => (
              <p key={p} className="text-[11px] text-amber-200">{p}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <Button className="w-full bg-emerald-600 hover:bg-emerald-500"
                disabled={!ready || submitting} onClick={submit}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" />
            : <><Check className="w-4 h-4 mr-1" /> Send for review</>}
        </Button>
        <p className="text-[10px] text-center text-muted-foreground">
          A person reads every market before it goes live. You can have three waiting
          at a time.
        </p>
      </div>
    </div>
  );
}
