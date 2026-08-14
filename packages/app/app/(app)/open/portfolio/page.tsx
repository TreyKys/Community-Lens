'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, Clock } from 'lucide-react';

// Your open-market holdings.
//
// This gets its own surface rather than joining the Live / Correct / Missed
// tabs on the bets page: those describe a bet waiting for one answer, and a
// holding here moves in value continuously and can be exited early. Forcing it
// into "Correct/Missed" would label it with a binary it does not have.
//
// The horizon prompt lives here as well as in a notification, because the whole
// horizon mechanic depends on someone actually seeing it — and a notification
// is the easiest thing in an app to miss.

type Row = {
  positionId: string; marketId: string; question: string; outcomeLabel: string;
  shares: number; costBasisTngn: number; currentPrice: number;
  markValueTngn: number; unrealisedPnlTngn: number;
  marketStatus: string; horizonWindowClosesAt?: string | null;
  inHorizonWindow: boolean; needsHorizonChoice: boolean;
  horizonChoice: 'roll' | 'cash_out' | null; status: string;
};

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export default function OpenPortfolioPage() {
  const { toast } = useToast();
  const [open, setOpen] = useState<Row[]>([]);
  const [closed, setClosed] = useState<Row[]>([]);
  const [totals, setTotals] = useState({ costTngn: 0, valueTngn: 0, pnlTngn: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }
      const r = await fetch('/api/open-markets/portfolio', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load');
      setOpen(d.open || []); setClosed(d.closed || []); setTotals(d.totals);
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const choose = async (row: Row, choice: 'roll' | 'cash_out') => {
    setBusy(row.positionId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`/api/open-markets/${row.marketId}/horizon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ positionId: row.positionId, choice }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save');
      toast({
        title: choice === 'roll' ? 'Staying in' : 'Cashing out',
        description: choice === 'roll'
          ? 'Your position carries on to the next review date.'
          : 'You will be paid out when the window closes.',
      });
      load();
    } catch (e: any) {
      toast({ title: 'Could not save', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );

  // Everything in a review window, answered or not. Answered ones stay pinned
  // up top rather than dropping back into the list, because the choice is still
  // changeable until the window closes and hiding it would imply it isn't.
  const inWindow = open.filter(r => r.inHorizonWindow);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <Link href="/open" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="w-4 h-4" /> Open markets
      </Link>

      <div>
        <h1 className="text-xl font-bold">Your positions</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Value updates as the market moves. You can sell any time — you don&rsquo;t have to wait for the answer.
        </p>
      </div>

      {/* Horizon prompts first. This is a decision with a deadline, so it
          outranks everything else on the page. */}
      {inWindow.length > 0 && (
        <div className="space-y-3">
          {inWindow.map(row => (
            <Card key={row.positionId} className="border-amber-500/40 bg-amber-500/[0.05]">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-amber-300 text-xs font-medium">
                  <Clock className="w-4 h-4" /> Review date reached
                </div>
                <p className="text-sm font-medium leading-snug">{row.question}</p>
                <p className="text-xs text-muted-foreground">
                  You hold {Math.round(row.shares).toLocaleString()} × {row.outcomeLabel}.
                  This market hasn&rsquo;t resolved yet, so you choose: stay in, or take your money out now.
                </p>
                {row.horizonWindowClosesAt && (
                  <p className="text-[11px] text-amber-200/80">
                    Closes {new Date(row.horizonWindowClosesAt).toLocaleString()}.
                    <span className="text-muted-foreground">
                      {row.horizonChoice
                        ? ' You can change your mind until then.'
                        : ' If you do nothing, you stay in.'}
                    </span>
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Button size="sm"
                          variant={row.horizonChoice === 'roll' ? 'default' : 'outline'}
                          disabled={busy === row.positionId}
                          onClick={() => choose(row, 'roll')}>
                    {row.horizonChoice === 'roll' ? '✓ Staying in' : 'Stay in'}
                  </Button>
                  <Button size="sm" disabled={busy === row.positionId}
                          variant={row.horizonChoice === 'cash_out' ? 'default' : 'outline'}
                          className={row.horizonChoice === 'cash_out'
                            ? 'bg-emerald-600 hover:bg-emerald-500'
                            : 'border-emerald-600/40 text-emerald-400 hover:bg-emerald-600/10'}
                          onClick={() => choose(row, 'cash_out')}>
                    {busy === row.positionId
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : row.horizonChoice === 'cash_out' ? '✓ Cashing out' : 'Cash out'}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Everyone cashing out at this review is paid at the same price, so it doesn&rsquo;t matter who decides first.
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {open.length > 0 && (
        <Card>
          <CardContent className="p-4 grid grid-cols-3 gap-3 text-center">
            <Stat label="Put in" value={ngn(totals.costTngn)} />
            <Stat label="Worth now" value={ngn(totals.valueTngn)} />
            <Stat label="Up / down" value={`${totals.pnlTngn >= 0 ? '+' : '−'}${ngn(Math.abs(totals.pnlTngn))}`}
                  tone={totals.pnlTngn >= 0 ? 'up' : 'down'} />
          </CardContent>
        </Card>
      )}

      {open.length === 0 && closed.length === 0 ? (
        <Card><CardContent className="p-8 text-center space-y-2">
          <p className="text-sm font-medium">Nothing here yet</p>
          <p className="text-xs text-muted-foreground">Buy a share in an open market and it&rsquo;ll show up here.</p>
          <Link href="/open"><Button size="sm" variant="outline" className="mt-2">Browse markets</Button></Link>
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {open.filter(r => !r.inHorizonWindow).map(row => (
            <Link key={row.positionId} href={`/open/${row.marketId}`} className="block">
              <Card className="transition-colors duration-150 hover:border-emerald-500/30 active:border-emerald-500/50">
                <CardContent className="p-4 space-y-2">
                  <p className="text-sm font-medium leading-snug">{row.question}</p>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {Math.round(row.shares).toLocaleString()} × {row.outcomeLabel} · now {pct(row.currentPrice)}
                    </span>
                    <span className={`tabular font-medium ${row.unrealisedPnlTngn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {row.unrealisedPnlTngn >= 0 ? '▲' : '▼'} {ngn(Math.abs(row.unrealisedPnlTngn))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Paid {ngn(row.costBasisTngn)} · worth {ngn(row.markValueTngn)}</span>
                    {row.marketStatus !== 'open' && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">{row.marketStatus}</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}

          {closed.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground pt-2">Finished</p>
              {closed.map(row => (
                <Card key={row.positionId} className="opacity-70">
                  <CardContent className="p-4 space-y-1">
                    <p className="text-sm leading-snug">{row.question}</p>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{row.outcomeLabel} · paid {ngn(row.costBasisTngn)}</span>
                      <Badge variant="outline" className="text-[9px] px-1 py-0">
                        {row.status === 'settled' ? 'settled'
                          : row.status === 'cashed_out' ? 'cashed out' : row.status}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-center text-muted-foreground pt-2">
        &ldquo;Worth now&rdquo; is at the current price. Selling moves the price a little, so open a market to see exactly what you&rsquo;d receive.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold tabular ${
        tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : ''
      }`}>{value}</p>
    </div>
  );
}
