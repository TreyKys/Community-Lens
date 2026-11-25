'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, TrendingUp, Clock, Lock, Flame } from 'lucide-react';
import { cn } from '@/lib/utils';

// The Run — player surface.
//
// The whole product has to read in one glance: five fixtures, mark W/D/L on
// each, one stake. The thing that needs explaining is that a miss does not
// kill the card, it shrinks it — so the quote shows BOTH the all-five number
// and the four-of-five number. Partial credit is the point of difference and
// it is invisible unless we put a figure on it.

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;
type Leg = { leg_index: number; fixture: string; kickoff_at: string | null;
             odds_w: number; odds_d: number; odds_l: number; result: string | null };
type Run = { id: string; title: string; kind: string; status: string; closes_at: string;
             min_stake_tngn: number; max_stake_tngn: number; legs: Leg[] };
type Entry = { id: string; run_id: string; stake_tngn: number; status: string;
               payout_tngn: number | null; cashed_out_tngn: number | null;
               currentValueTngn: number | null; cashOutTngn: number | null;
               picks: { leg_index: number; pick: string; odds: number }[] };

export default function RunsPage() {
  const { toast } = useToast();
  const [session, setSession] = useState<any>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [mine, setMine] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/runs', {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const d = await r.json();
      setRuns(d.runs || []); setMine(d.myEntries || []);
    } catch { /* keep whatever we had */ } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="max-w-md mx-auto p-4 space-y-4 pb-24">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Flame className="w-5 h-5 text-emerald-400" /> The Run
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Five fixtures. One stake. Call them right and your position grows — miss one and it
          shrinks, it doesn&rsquo;t die. Cash out whenever you like.
        </p>
      </div>

      {mine.filter(e => e.status === 'live').length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Your live Runs</p>
          {mine.filter(e => e.status === 'live').map(e => (
            <LiveEntry key={e.id} entry={e} run={runs.find(r => r.id === e.run_id)}
                       session={session} reload={load} />
          ))}
        </div>
      )}

      {runs.length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          No Runs open right now. Check back soon.
        </CardContent></Card>
      )}

      {runs.map(run => (
        <RunCard key={run.id} run={run} session={session}
                 open={openId === run.id} onToggle={() => setOpenId(openId === run.id ? null : run.id)}
                 reload={load} alreadyIn={mine.some(e => e.run_id === run.id && e.status === 'live')} />
      ))}

      {mine.filter(e => e.status !== 'live').length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Finished</p>
          {mine.filter(e => e.status !== 'live').map(e => (
            <Card key={e.id}><CardContent className="p-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">{runs.find(r => r.id === e.run_id)?.title || 'Run'}</p>
                <p className="text-[10px] text-muted-foreground">
                  {ngn(e.stake_tngn)} staked · {e.status === 'cashed_out' ? 'cashed out' : e.status}
                </p>
              </div>
              <span className={cn('text-sm font-bold tabular-nums',
                (e.payout_tngn ?? e.cashed_out_tngn ?? 0) >= e.stake_tngn ? 'text-emerald-400' : 'text-muted-foreground')}>
                {ngn(e.payout_tngn ?? e.cashed_out_tngn ?? 0)}
              </span>
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── A live position ───────────────────────────────────────────────────────
function LiveEntry({ entry, run, session, reload }: any) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const graded = (run?.legs || []).filter((l: Leg) => l.result).length;
  const hits = (run?.legs || []).filter((l: Leg) =>
    l.result && entry.picks.find((p: any) => p.leg_index === l.leg_index)?.pick === l.result).length;

  const cashOut = async () => {
    if (!session?.access_token) return;
    setBusy(true);
    try {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'cashout', entryId: entry.id, dryRun: false }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: 'Cashed out', description: `${ngn(d.valueTngn)} is in your balance.` });
      reload();
    } catch (e: any) {
      toast({ title: 'Could not cash out', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  return (
    <Card className="border-emerald-500/30">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium">{run?.title || 'Run'}</p>
          <Badge variant="outline" className="text-[9px] shrink-0">{graded}/5 played</Badge>
        </div>

        <div className="flex items-end justify-between">
          <div>
            <p className="text-[10px] text-muted-foreground">Position</p>
            <p className="text-2xl font-bold tabular-nums text-emerald-300">
              {ngn(entry.currentValueTngn ?? 0)}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {ngn(entry.stake_tngn)} staked · {hits}/{graded || 0} right so far
            </p>
          </div>
          {entry.cashOutTngn !== null ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={cashOut}
                    className="border-emerald-500/40 text-emerald-300">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Cash out ${ngn(entry.cashOutTngn)}`}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Lock className="w-3 h-3" /> locked while playing
            </span>
          )}
        </div>

        <div className="flex gap-1 pt-1">
          {(run?.legs || []).map((l: Leg) => {
            const pick = entry.picks.find((p: any) => p.leg_index === l.leg_index)?.pick;
            const done = !!l.result;
            const hit = done && pick === l.result;
            return (
              <div key={l.leg_index}
                   className={cn('flex-1 h-1.5 rounded-full',
                     !done ? 'bg-muted' : hit ? 'bg-emerald-500' : 'bg-red-500/60')} />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Build a card ──────────────────────────────────────────────────────────
function RunCard({ run, session, open, onToggle, reload, alreadyIn }: any) {
  const { toast } = useToast();
  const [picks, setPicks] = useState<Record<number, 'W' | 'D' | 'L'>>({});
  const [stake, setStake] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const complete = Object.keys(picks).length === 5;
  const stakeNum = Number(stake);
  const validStake = Number.isFinite(stakeNum)
    && stakeNum >= run.min_stake_tngn && stakeNum <= run.max_stake_tngn;

  useEffect(() => {
    if (!complete || !validStake) { setQuote(null); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const r = await fetch('/api/runs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'quote', runId: run.id, stake: stakeNum,
            picks: Object.entries(picks).map(([i, p]) => ({ leg_index: Number(i), pick: p })),
          }),
        });
        const d = await r.json();
        setQuote(r.ok ? d : null);
      } catch { setQuote(null); } finally { setQuoting(false); }
    }, 350);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [picks, stakeNum, complete, validStake, run.id]);

  const place = async () => {
    if (!session?.access_token) { toast({ title: 'Sign in to play', variant: 'destructive' }); return; }
    setPlacing(true);
    try {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          action: 'enter', runId: run.id, stake: stakeNum,
          picks: Object.entries(picks).map(([i, p]) => ({ leg_index: Number(i), pick: p })),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: '🔥 You\'re in', description: `Up to ${ngn(d.maxPayoutTngn)} if all five land.` });
      setPicks({}); setStake(''); setQuote(null); reload();
    } catch (e: any) {
      toast({ title: 'Could not enter', description: e.message, variant: 'destructive' });
    } finally { setPlacing(false); }
  };

  const closed = run.status !== 'open' || new Date(run.closes_at) <= new Date();

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <button className="w-full text-left" onClick={onToggle}>
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">{run.title}</p>
            {closed
              ? <Badge variant="outline" className="text-[9px] shrink-0">closed</Badge>
              : <Badge className="text-[9px] bg-emerald-600 shrink-0">open</Badge>}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> closes {new Date(run.closes_at).toLocaleString()}
            {alreadyIn && <span className="text-emerald-400">· you&rsquo;re in</span>}
          </p>
        </button>

        {open && (
          <div className="space-y-3 pt-1 border-t border-border">
            <p className="text-[10px] text-muted-foreground">Mark each fixture: Win, Draw or Loss.</p>

            <div className="space-y-1.5">
              {run.legs.map((l: Leg) => (
                <div key={l.leg_index} className="flex items-center gap-2">
                  <span className="text-[11px] flex-1 truncate">{l.fixture}</span>
                  <div className="flex gap-1 shrink-0">
                    {([['W', l.odds_w], ['D', l.odds_d], ['L', l.odds_l]] as const).map(([k, o]) => (
                      <button key={k} disabled={closed}
                              onClick={() => setPicks({ ...picks, [l.leg_index]: k as any })}
                              className={cn(
                                'w-12 py-1 rounded border text-[10px] font-semibold transition-colors disabled:opacity-40',
                                picks[l.leg_index] === k
                                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                                  : 'border-border hover:border-emerald-500/40')}>
                        <span className="block">{k}</span>
                        <span className="block text-[9px] text-muted-foreground tabular-nums">{Number(o).toFixed(2)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {!closed && (
              <>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">
                    Stake (₦{run.min_stake_tngn}–{run.max_stake_tngn.toLocaleString()})
                  </p>
                  <Input value={stake} inputMode="numeric" placeholder={`Min ₦${run.min_stake_tngn}`}
                         onChange={e => setStake(e.target.value)} className="h-9 text-sm" />
                </div>

                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
                  {quoting ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Pricing…
                    </p>
                  ) : quote ? (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-emerald-300/90 font-semibold">
                          All five land
                        </span>
                        <span className="text-xl font-bold tabular-nums text-emerald-300">
                          {ngn(quote.allFiveTngn)}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between mt-1">
                        <span className="text-[10px] text-muted-foreground">Four of five</span>
                        <span className="text-sm font-semibold tabular-nums text-muted-foreground">
                          {ngn(quote.fourOfFiveTngn)}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2 flex items-start gap-1">
                        <TrendingUp className="w-3 h-3 shrink-0 mt-px" />
                        Every fixture you call right multiplies your position. Miss one and it shrinks —
                        you still keep something.
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {complete ? 'Enter a stake to see what it pays.' : 'Mark all five fixtures.'}
                    </p>
                  )}
                </div>

                <Button className="w-full bg-emerald-600 hover:bg-emerald-500"
                        disabled={!complete || !validStake || placing || !quote}
                        onClick={place}>
                  {placing ? <Loader2 className="w-4 h-4 animate-spin" />
                    : !session ? 'Sign in to play'
                    : !complete ? 'Mark all five'
                    : !validStake ? 'Enter a stake'
                    : `Enter the Run · ${ngn(stakeNum)}`}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
