'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Clock, Lock, Flame, ArrowRight, Check, X as XIcon, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

// The Run — player surface.
//
// Reads in one glance: five fixtures, mark W/D/L, one stake. The thing that
// needs explaining is that a miss does not kill the card, it shrinks it — so
// the quote always shows the four-of-five figure beside the all-five one.
// Partial credit is the whole point of difference from a parlay and it is
// invisible to a player unless there is a number on it.
//
// Amber/flame throughout, deliberately: emerald is the markets, violet is the
// Multiplier. A new product that looks like the old ones reads as a tab
// nobody needs to open.

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
    } catch { /* keep what we had */ } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => { load(); }, [load]);

  const live = mine.filter(e => e.status === 'live');
  const done = mine.filter(e => e.status !== 'live');

  return (
    <div className="max-w-md mx-auto pb-24">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-b-3xl border-b border-amber-500/20
                      bg-gradient-to-br from-amber-500/[0.16] via-orange-500/[0.07] to-transparent px-5 pt-7 pb-6">
        <div className="absolute -top-16 -right-10 w-48 h-48 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="relative">
          {/* Wordmark. "The" recedes so "Run" carries the name — the product is
              "a Run", and the article is just grammar. The italic and the tight
              tracking are doing the same job the product does: motion. */}
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl shrink-0
                             bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500
                             shadow-lg shadow-amber-500/30">
              <Flame className="w-5 h-5 text-[#1a1206]" strokeWidth={2.5} />
            </span>
            <h1 className="flex items-baseline gap-1.5 leading-none">
              <span className="text-base font-semibold tracking-tight text-amber-100/45">The</span>
              <span className="text-[34px] font-black italic tracking-[-0.045em]
                               bg-gradient-to-br from-amber-100 via-amber-300 to-orange-500
                               bg-clip-text text-transparent drop-shadow-[0_2px_12px_rgba(251,191,36,0.25)]">
                Run
              </span>
            </h1>
            <span className="relative inline-flex items-center gap-1 self-start mt-1 px-2 py-0.5 rounded-full
                             bg-gradient-to-r from-orange-500 to-red-500 shadow-md shadow-orange-500/30">
              <span className="absolute inset-0 rounded-full bg-orange-500/50 animate-ping" />
              <Flame className="relative w-2.5 h-2.5 text-white" strokeWidth={3} />
              <span className="relative text-[9px] font-black tracking-wider text-white">HOT</span>
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground mt-2.5 leading-relaxed">
            Five fixtures. <span className="text-amber-200/90 font-medium">One stake.</span> Call them
            right and your position grows week by week — miss one and it shrinks, it doesn&rsquo;t die.
          </p>
          <p className="text-[11px] text-amber-300/80 mt-1.5 font-medium">
            Cash out whenever you like. Or hold your nerve.
          </p>
        </div>
      </div>

      <div className="px-4 space-y-4 mt-4">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {live.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-wider text-amber-300/80 font-bold px-1">
                  Your live Runs
                </p>
                {live.map(e => (
                  <LiveEntry key={e.id} entry={e} run={runs.find(r => r.id === e.run_id)}
                             session={session} reload={load} />
                ))}
              </div>
            )}

            {runs.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="p-10 text-center">
                  <Flame className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">No Runs open right now.</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">New cards drop every week.</p>
                </CardContent>
              </Card>
            )}

            {runs.map(run => (
              <RunCard key={run.id} run={run} session={session}
                       open={openId === run.id}
                       onToggle={() => setOpenId(openId === run.id ? null : run.id)}
                       reload={load}
                       alreadyIn={mine.some(e => e.run_id === run.id && e.status === 'live')} />
            ))}

            {done.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold px-1">Finished</p>
                {done.map(e => {
                  const got = e.payout_tngn ?? e.cashed_out_tngn ?? 0;
                  const up = got >= e.stake_tngn;
                  return (
                    <Card key={e.id}><CardContent className="p-3 flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">
                          {runs.find(r => r.id === e.run_id)?.title || 'Run'}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {ngn(e.stake_tngn)} staked · {e.status === 'cashed_out' ? 'cashed out' : e.status}
                        </p>
                      </div>
                      <span className={cn('text-sm font-bold tabular-nums shrink-0',
                        up ? 'text-amber-300' : 'text-muted-foreground')}>
                        {ngn(got)}
                      </span>
                    </CardContent></Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── A live position ───────────────────────────────────────────────────────
function LiveEntry({ entry, run, session, reload }: any) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const legs: Leg[] = run?.legs || [];
  const graded = legs.filter(l => l.result).length;
  const hits = legs.filter(l =>
    l.result && entry.picks.find((p: any) => p.leg_index === l.leg_index)?.pick === l.result).length;
  const up = (entry.currentValueTngn ?? 0) >= entry.stake_tngn;

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
      toast({
        title: 'Cashed out',
        description: d.bonusTngn > 0
          // Bonus-funded entries pay out mostly as bonus. Saying only the
          // total here would read as money missing from the wallet.
          ? `${ngn(d.cashTngn)} withdrawable, ${ngn(d.bonusTngn)} back as bonus credit.`
          : `${ngn(d.valueTngn)} is in your balance.`,
      });
      reload();
    } catch (e: any) {
      toast({ title: 'Could not cash out', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  return (
    <Card className="border-amber-500/30 bg-gradient-to-br from-amber-500/[0.07] to-transparent overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-semibold truncate">{run?.title || 'Run'}</p>
          <Badge variant="outline" className="text-[9px] shrink-0 border-amber-500/30 text-amber-300">
            {graded}/5 played
          </Badge>
        </div>

        {/* the five fixtures as pips */}
        <div className="flex gap-1.5">
          {legs.map(l => {
            const pick = entry.picks.find((p: any) => p.leg_index === l.leg_index)?.pick;
            const done = !!l.result;
            const hit = done && pick === l.result;
            return (
              <div key={l.leg_index}
                   className={cn('flex-1 h-7 rounded-md flex items-center justify-center text-[10px] font-bold',
                     !done ? 'bg-muted/60 text-muted-foreground/50'
                       : hit ? 'bg-amber-500/90 text-amber-950'
                       : 'bg-red-500/20 text-red-300/80')}>
                {done ? (hit ? <Check className="w-3.5 h-3.5" /> : <XIcon className="w-3.5 h-3.5" />) : pick}
              </div>
            );
          })}
        </div>

        <div className="flex items-end justify-between gap-3 pt-1">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Position now
            </p>
            <p className={cn('text-3xl font-black tabular-nums leading-none mt-0.5',
              up ? 'text-amber-300' : 'text-foreground/80')}>
              {ngn(entry.currentValueTngn ?? 0)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              {ngn(entry.stake_tngn)} staked · {hits}/{graded} right
            </p>
          </div>
          {entry.cashOutTngn !== null ? (
            <Button size="sm" disabled={busy} onClick={cashOut}
                    className="shrink-0 bg-amber-500 hover:bg-amber-400 text-amber-950 font-bold">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <>Cash out {ngn(entry.cashOutTngn)}</>}
            </Button>
          ) : (
            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-muted-foreground
                             border border-border rounded-md px-2 py-1.5">
              <Lock className="w-3 h-3" /> in play
            </span>
          )}
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

  const picked = Object.keys(picks).length;
  const complete = picked === 5;
  const stakeNum = Number(stake);
  const validStake = Number.isFinite(stakeNum)
    && stakeNum >= run.min_stake_tngn && stakeNum <= run.max_stake_tngn;
  const closed = run.status !== 'open' || new Date(run.closes_at) <= new Date();

  useEffect(() => {
    if (!complete || !validStake) { setQuote(null); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const r = await fetch('/api/runs', {
          method: 'POST',
          // Signed so the quote can tell us whether this stake would come out
          // of bonus credit, which changes what the payout is actually worth.
          headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
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
  }, [picks, stakeNum, complete, validStake, run.id, session?.access_token]);

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
      toast({ title: "🔥 You're in", description: `Up to ${ngn(d.maxPayoutTngn)} if all five land.` });
      setPicks({}); setStake(''); setQuote(null); reload();
    } catch (e: any) {
      toast({ title: 'Could not enter', description: e.message, variant: 'destructive' });
    } finally { setPlacing(false); }
  };

  return (
    <Card className={cn('overflow-hidden transition-colors',
      open ? 'border-amber-500/40' : 'hover:border-amber-500/25')}>
      <CardContent className="p-0">
        <button className="w-full text-left p-4" onClick={onToggle}>
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-bold leading-snug">{run.title}</p>
            {closed
              ? <Badge variant="outline" className="text-[9px] shrink-0">closed</Badge>
              : <Badge className="text-[9px] bg-amber-500 text-amber-950 font-bold shrink-0">OPEN</Badge>}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" /> closes {new Date(run.closes_at).toLocaleDateString('en-NG',
                { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
            {alreadyIn && <span className="text-amber-400 font-medium">you&rsquo;re in</span>}
          </div>
          {!open && (
            <div className="flex items-center gap-1 mt-3">
              {run.legs.map((l: Leg) => (
                <div key={l.leg_index} className="flex-1 h-1 rounded-full bg-amber-500/20" />
              ))}
              <span className="text-[10px] text-muted-foreground ml-2 shrink-0">5 fixtures</span>
            </div>
          )}
        </button>

        {open && (
          <div className="px-4 pb-4 space-y-3">
            <div className="rounded-lg bg-muted/30 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                Mark every fixture <span className="text-foreground font-medium">Win</span>,{' '}
                <span className="text-foreground font-medium">Draw</span> or{' '}
                <span className="text-foreground font-medium">Loss</span>.
                <span className="text-amber-300/90"> {picked}/5 picked</span>
              </p>
            </div>

            <div className="space-y-2">
              {run.legs.map((l: Leg) => (
                <div key={l.leg_index} className="space-y-1.5">
                  <p className="text-[11px] font-medium truncate">{l.fixture}</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {([['W', 'Win', l.odds_w], ['D', 'Draw', l.odds_d], ['L', 'Loss', l.odds_l]] as const).map(
                      ([k, label, o]) => {
                        const on = picks[l.leg_index] === k;
                        return (
                          <button key={k} disabled={closed}
                                  onClick={() => setPicks({ ...picks, [l.leg_index]: k as any })}
                                  className={cn(
                                    'py-2 rounded-lg border text-center transition-all active:scale-[0.97] disabled:opacity-40',
                                    on ? 'border-amber-500 bg-amber-500/15 shadow-sm shadow-amber-500/20'
                                       : 'border-border hover:border-amber-500/40 hover:bg-amber-500/[0.04]')}>
                            <span className={cn('block text-[10px] font-bold',
                              on ? 'text-amber-300' : 'text-muted-foreground')}>{label}</span>
                            <span className={cn('block text-xs font-bold tabular-nums mt-0.5',
                              on ? 'text-amber-200' : 'text-foreground/80')}>{Number(o).toFixed(2)}</span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>

            {!closed && (
              <>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">
                    Stake — ₦{run.min_stake_tngn.toLocaleString()} to ₦{run.max_stake_tngn.toLocaleString()}
                  </p>
                  <Input value={stake} inputMode="numeric" placeholder={`Min ₦${run.min_stake_tngn}`}
                         onChange={e => setStake(e.target.value)} className="h-10 text-sm font-medium" />
                  <div className="flex gap-1.5 mt-1.5">
                    {[100, 200, 500, 1000].filter(v => v <= run.max_stake_tngn).map(v => (
                      <button key={v} onClick={() => setStake(String(v))}
                              className="text-[11px] px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-300
                                         hover:bg-amber-500/20 transition-colors font-medium">
                        ₦{v.toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-amber-500/25 bg-gradient-to-br
                                from-amber-500/[0.1] to-transparent p-3.5">
                  {quoting ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Pricing…
                    </p>
                  ) : quote ? (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-amber-300/90 font-bold">
                          All five land
                        </span>
                        <span className="text-2xl font-black tabular-nums text-amber-300 leading-none">
                          {ngn(quote.allFiveTngn)}
                        </span>
                      </div>
                      {/* The whole ladder. "All five pays X" is the least
                          informative number on the card — the shape is the
                          product, and a player deciding whether to enter is
                          really asking "what if I get three?". Rungs are
                          ranges because it depends which legs land. */}
                      {Array.isArray(quote.ladder) && (
                        <div className="mt-2.5 pt-2.5 border-t border-amber-500/15 space-y-1">
                          {quote.ladder.slice().reverse().filter((r: any) => r.hits < 5).map((r: any) => {
                            const win = r.low >= stakeNum;
                            const loss = r.high < stakeNum;
                            return (
                              <div key={r.hits} className="flex items-baseline justify-between gap-2">
                                <span className="text-[11px] text-muted-foreground">
                                  {r.hits} of five
                                </span>
                                <span className={cn('text-[11px] font-bold tabular-nums',
                                  win ? 'text-amber-300/90'
                                      : loss ? 'text-muted-foreground/60'
                                             : 'text-foreground/70')}>
                                  {r.low === r.high || r.hits === 0
                                    ? ngn(r.high)
                                    : `${ngn(r.low)} – ${ngn(r.high)}`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-2.5 leading-relaxed">
                        Everything pays something — but it takes{' '}
                        <span className="text-amber-300/90">three right just to get your stake
                        back</span>, and the whole card to be paid properly.
                      </p>

                      {/* Shown only when this stake would actually trigger the split,
                          and stated as the two numbers rather than as a percentage
                          rule — "₦740 withdrawable" is understood, "10% cash share"
                          is not. Same rule as single bets and Multiplier. */}
                      {quote.funding && quote.funding.cashShareOfWinnings < 1 && (
                        <div className="mt-2.5 pt-2.5 border-t border-amber-500/15 flex gap-2">
                          <Info className="w-3 h-3 text-amber-400/80 shrink-0 mt-[2px]" />
                          <p className="text-[10px] text-muted-foreground leading-relaxed">
                            {Math.round(quote.funding.bonusProportion * 100)}% of this stake comes
                            from bonus credit, so of a winning payout{' '}
                            <span className="text-amber-200/90 font-medium">
                              {ngn(quote.allFiveTngn * quote.funding.cashShareOfWinnings)}
                            </span>{' '}
                            would be withdrawable cash and the rest returns as bonus. Stake more of
                            your own balance to keep all of it.
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {complete ? 'Enter a stake to see what it pays.' : `Mark all five — ${5 - picked} to go.`}
                    </p>
                  )}
                </div>

                <Button className="w-full h-11 bg-gradient-to-r from-amber-500 to-orange-500
                                   hover:from-amber-400 hover:to-orange-400 text-amber-950 font-bold
                                   disabled:opacity-40 disabled:grayscale"
                        disabled={!complete || !validStake || placing || !quote}
                        onClick={place}>
                  {placing ? <Loader2 className="w-4 h-4 animate-spin" />
                    : !session ? 'Sign in to play'
                    : !complete ? `Mark all five — ${5 - picked} to go`
                    : !validStake ? 'Enter a stake'
                    : <>Enter the Run · {ngn(stakeNum)} <ArrowRight className="w-4 h-4 ml-1" /></>}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
