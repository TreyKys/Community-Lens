'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, Plus } from 'lucide-react';

// Your markets.
//
// The threshold is the entire incentive of this feature and it was invisible
// to the one person it exists to motivate. It is shown as PROGRESS TOWARD a
// goal rather than a gate you have not passed: the same number framed as
// "₦4,200 of fees to go" reads as something achievable, where "you have earned
// nothing" reads as a con.
//
// Review notes appear here too. A "needs changes" decision is worthless unless
// the reason reaches the person who has to make the change.

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;

type M = {
  id: string; question: string; category: string; outcomes: string[]; status: string;
  reviewNotes: string | null; reviewScore: number | null;
  createdAt: string; openedAt: string | null; tradingClosesAt: string | null;
  traders: number; trades: number;
  feesTngn: number; thresholdTngn: number; thresholdProgress: number;
  feesToThresholdTngn: number; earnedTngn: number; paidTngn: number; claimableTngn: number;
};

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  pending_review: { label: 'With reviewers', tone: 'text-amber-300' },
  revise:         { label: 'Needs changes',  tone: 'text-amber-400' },
  rejected:       { label: 'Not approved',   tone: 'text-red-400' },
  open:           { label: 'Live',           tone: 'text-emerald-400' },
  horizon_window: { label: 'Review window',  tone: 'text-amber-300' },
  closed:         { label: 'Trading closed', tone: 'text-muted-foreground' },
  halted:         { label: 'Paused',         tone: 'text-amber-400' },
  pending_payout: { label: 'Paying out',     tone: 'text-emerald-400' },
  resolved:       { label: 'Finished',       tone: 'text-muted-foreground' },
  voided:         { label: 'Voided',         tone: 'text-muted-foreground' },
  retired:        { label: 'Retired',        tone: 'text-muted-foreground' },
};

export default function CreatorPage() {
  const { toast } = useToast();
  const [markets, setMarkets] = useState<M[]>([]);
  const [totals, setTotals] = useState({ earnedTngn: 0, claimableTngn: 0, feesTngn: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }
      const r = await fetch('/api/open-markets/creator', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load');
      setMarkets(d.markets || []); setTotals(d.totals);
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const claim = async (m: M) => {
    setBusy(m.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch('/api/open-markets/creator', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ marketId: m.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not pay out');
      toast({ title: `${ngn(d.paidTngn)} paid to your wallet` });
      load();
    } catch (e: any) {
      toast({ title: 'Not paid', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4 pb-24">
      <Link href="/open" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="w-4 h-4" /> Open markets
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Your markets</h1>
          <p className="text-xs text-muted-foreground mt-1">
            You earn 25% of fees once a market covers what we put up to start it.
          </p>
        </div>
        <Link href="/open/create">
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500 shrink-0">
            <Plus className="w-4 h-4 mr-1" /> New
          </Button>
        </Link>
      </div>

      {markets.length > 0 && (
        <Card>
          <CardContent className="p-4 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground">Ready to take</p>
              <p className={`text-base font-semibold tabular ${
                totals.claimableTngn > 0 ? 'text-emerald-400' : ''}`}>
                {ngn(totals.claimableTngn)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Paid so far</p>
              <p className="text-base font-semibold tabular">{ngn(totals.earnedTngn)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Fees generated</p>
              <p className="text-base font-semibold tabular">{ngn(totals.feesTngn)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {markets.length === 0 ? (
        <Card><CardContent className="p-8 text-center space-y-2">
          <p className="text-sm font-medium">You haven&rsquo;t made a market yet</p>
          <p className="text-xs text-muted-foreground">
            Ask something people will argue about. If it gets busy, you earn from it.
          </p>
          <Link href="/open/create">
            <Button size="sm" className="mt-2 bg-emerald-600 hover:bg-emerald-500">
              Create one
            </Button>
          </Link>
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {markets.map(m => {
            const s = STATUS_COPY[m.status] || { label: m.status, tone: 'text-muted-foreground' };
            const live = ['open', 'horizon_window', 'closed', 'pending_payout', 'resolved'].includes(m.status);
            return (
              <Card key={m.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    {live ? (
                      <Link href={`/open/${m.id}`} className="text-sm font-medium leading-snug hover:underline">
                        {m.question}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium leading-snug">{m.question}</p>
                    )}
                    <Badge variant="outline" className={`text-[9px] shrink-0 ${s.tone}`}>
                      {s.label}
                    </Badge>
                  </div>

                  {/* The reviewer's actual words. Without this, "needs changes"
                      is an instruction with no content. */}
                  {m.reviewNotes && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] p-2">
                      <p className="text-[10px] text-amber-300 font-medium">From the reviewer</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{m.reviewNotes}</p>
                      {m.status === 'revise' && (
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Make these changes and submit it again — resubmitting is free.
                        </p>
                      )}
                    </div>
                  )}

                  {live && (
                    <>
                      <div className="flex gap-3 text-[11px] text-muted-foreground">
                        <span>{m.traders} trader{m.traders === 1 ? '' : 's'}</span>
                        <span>{m.trades} trade{m.trades === 1 ? '' : 's'}</span>
                        <span className="tabular">{ngn(m.feesTngn)} in fees</span>
                      </div>

                      {/* Progress toward the goal, not distance from a gate. */}
                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px]">
                          <span className="text-muted-foreground">
                            {m.feesToThresholdTngn > 0 ? 'Until you start earning' : 'Earning'}
                          </span>
                          <span className="tabular text-muted-foreground">
                            {ngn(m.feesTngn)} / {ngn(m.thresholdTngn)}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
                               style={{ width: `${Math.min(100, m.thresholdProgress * 100)}%` }} />
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {m.feesToThresholdTngn > 0
                            ? `${ngn(m.feesToThresholdTngn)} more in fees and you start taking 25% of everything after that.`
                            : 'Past the threshold — you now earn 25% of every fee this market makes.'}
                        </p>
                      </div>

                      {(m.claimableTngn > 0 || m.paidTngn > 0) && (
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <div className="text-[11px]">
                            {m.claimableTngn > 0 ? (
                              <span className="text-emerald-400 tabular">
                                {ngn(m.claimableTngn)} ready
                              </span>
                            ) : (
                              <span className="text-muted-foreground tabular">
                                {ngn(m.paidTngn)} paid out
                              </span>
                            )}
                          </div>
                          {m.claimableTngn > 0 && (
                            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500"
                                    disabled={busy === m.id} onClick={() => claim(m)}>
                              {busy === m.id
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : 'Take it'}
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {m.status === 'pending_review' && (
                    <p className="text-[11px] text-muted-foreground">
                      A person reads every market before it goes live. We usually decide within a day.
                    </p>
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
