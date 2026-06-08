'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Trophy, Sparkles, Loader2, CheckCircle2, Crown, Zap, Flame,
} from 'lucide-react';
import { AuthModal } from '@/components/AuthModal';

type SlotsState = { taken: number; cap: number; remaining: number; closed: boolean };

// Reward summary shown on the teaser — matches what we're marketing on
// social. Numbers are intentionally rounded; full T&Cs live on /terms.
const WEEKLY_PRIZES = [
  { rank: '1', reward: '₦15,000', type: 'CASH (withdrawable)', badge: 'Champion', icon: Crown, color: 'text-amber-400' },
  { rank: '2', reward: '₦3,000', type: 'Bonus credits', badge: 'Silver', icon: Trophy, color: 'text-slate-300' },
  { rank: '3', reward: '₦3,000', type: 'Bonus credits', badge: 'Bronze', icon: Trophy, color: 'text-orange-400' },
  { rank: '4–5', reward: '₦2,000 each', type: 'Bonus credits', badge: 'Top 5', icon: Sparkles, color: 'text-emerald-400' },
  { rank: '6–10', reward: '₦1,000 each', type: 'Bonus credits', badge: 'Top 10', icon: Sparkles, color: 'text-emerald-300' },
];

const DAILY_PRIZES = [
  { rank: '1', reward: '₦500 bonus credits', label: 'Daily MVP' },
  { rank: '2', reward: '₦300 bonus credits', label: '—' },
  { rank: '3', reward: '₦200 bonus credits', label: '—' },
];

export default function LeaderboardTeaserPage() {
  const { toast } = useToast();
  const [session, setSession] = useState<any>(null);
  const [slots, setSlots] = useState<SlotsState | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (alive) setSession(data.session);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/leaderboard/waitlist');
        const data = await res.json();
        if (alive) setSlots(data);
      } catch {
        // non-critical
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const submitWaitlist = async (payload: { userId?: string; email?: string; phone?: string; source?: string }) => {
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/leaderboard/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not join waitlist');
      setJoined(true);
      toast({
        title: data.alreadyJoined ? "You're already in 🎯" : "You're on the list 🏆",
        description: 'We\'ll email you the moment the leaderboard goes live.',
      });
    } catch (err: any) {
      toast({ title: 'Could not join', description: err.message, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignedInJoin = () => {
    if (!session?.user?.id) return;
    submitWaitlist({ userId: session.user.id, source: source || 'logged_in_one_click' });
  };

  const handleAnonJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast({ title: 'Email required', variant: 'destructive' });
      return;
    }
    submitWaitlist({
      email: email.trim(),
      phone: phone.trim() || undefined,
      source: source.trim() || undefined,
    });
  };

  const fillPct = slots ? Math.min(100, Math.round((slots.taken / slots.cap) * 100)) : 0;
  const isClosed = slots?.closed;

  return (
    <div className="relative min-h-screen">
      {/* Background glow */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-40">
        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_0%,rgba(251,191,36,0.18),transparent_60%)]" />
        <div className="absolute top-1/3 right-0 w-[400px] h-[400px] rounded-full bg-amber-500/15 blur-[140px] mix-blend-screen" />
        <div className="absolute bottom-0 left-1/4 w-[500px] h-[500px] rounded-full bg-emerald-500/10 blur-[150px] mix-blend-screen" />
      </div>

      <div className="relative z-10 max-w-3xl mx-auto p-4 md:p-8 space-y-6 pb-24">
        {/* Hero */}
        <div className="text-center space-y-3 pt-4">
          <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-3 py-1">
            <Flame className="w-3 h-3 mr-1" /> Launching Soon — Pre-Register
          </Badge>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight">
            The Opinions.ng <span className="text-amber-400">Leaderboard</span>
          </h1>
          <p className="text-sm md:text-base text-muted-foreground max-w-xl mx-auto">
            Predict smarter. Wager louder. Win cash + bonus credits every week and every day.
            Pre-register now to lock your seat — slots are limited.
          </p>
        </div>

        {/* Slots / FOMO bar */}
        {slots && (
          <Card className={`border ${isClosed ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold uppercase tracking-wider">
                  {isClosed ? 'Waitlist Closed' : 'Slots Claimed'}
                </span>
                <span className="font-mono">
                  {slots.taken.toLocaleString()} / {slots.cap.toLocaleString()}
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${isClosed ? 'bg-red-500' : 'bg-gradient-to-r from-amber-500 to-emerald-400'}`}
                  style={{ width: `${fillPct}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {isClosed
                  ? 'Pre-registration is closed. The leaderboard goes live to claimed seats first.'
                  : `${slots.remaining.toLocaleString()} seats left — once it fills, signups halt until launch.`}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Signup card */}
        {!joined ? (
          <Card className="border-amber-500/30">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <h2 className="text-lg font-semibold">Claim your seat</h2>
              </div>

              {isClosed ? (
                <p className="text-sm text-muted-foreground">
                  We&apos;ve hit the cap for the launch cohort. Follow us on X and IG for the next intake window.
                </p>
              ) : session ? (
                // Signed-in: 1-click flow
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    You&apos;re signed in as <span className="text-foreground font-medium">{session.user.email}</span>.
                    One click and you&apos;re in.
                  </p>
                  <div className="space-y-2">
                    <Label className="text-xs">How did you hear about us? (optional)</Label>
                    <Input
                      placeholder="X / Instagram / friend / Google"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                    />
                  </div>
                  <Button
                    onClick={handleSignedInJoin}
                    disabled={isSubmitting}
                    className="w-full bg-amber-600 hover:bg-amber-500 text-white font-semibold"
                  >
                    {isSubmitting
                      ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Reserving…</>
                      : <><Crown className="w-4 h-4 mr-2" />Reserve My Seat</>
                    }
                  </Button>
                </div>
              ) : (
                // Anonymous: form + auth nudge
                <form className="space-y-3" onSubmit={handleAnonJoin}>
                  <div className="space-y-2">
                    <Label className="text-xs">Email *</Label>
                    <Input
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-xs">Phone (optional)</Label>
                      <Input
                        type="tel"
                        placeholder="+234…"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">How did you hear about us?</Label>
                      <Input
                        placeholder="X / IG / friend…"
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                      />
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={isSubmitting || !email}
                    className="w-full bg-amber-600 hover:bg-amber-500 text-white font-semibold"
                  >
                    {isSubmitting
                      ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Reserving…</>
                      : <>Reserve My Seat</>
                    }
                  </Button>

                  <div className="pt-2 text-center text-xs text-muted-foreground">
                    Already an account? <span className="text-amber-300">Sign in</span> for a 1-click reservation.
                    <div className="mt-2 flex justify-center">
                      <AuthModal />
                    </div>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-emerald-500/40 bg-emerald-500/5">
            <CardContent className="p-5 flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
              <div>
                <p className="text-sm font-semibold">You&apos;re on the list.</p>
                <p className="text-xs text-muted-foreground">
                  We&apos;ll email you the second the leaderboard goes live. Bring your A-game.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Weekly prizes */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Trophy className="w-4 h-4 text-amber-400" />
            <h3 className="text-base font-semibold">Weekly Prize Pool</h3>
            <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-300">
              Resets Mon 00:00 WAT
            </Badge>
          </div>
          <Card>
            <CardContent className="p-0 divide-y divide-border/40">
              {WEEKLY_PRIZES.map((p) => (
                <div key={p.rank} className="flex items-center gap-3 p-3">
                  <div className="w-10 text-center font-bold tabular-nums text-sm">
                    #{p.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{p.reward}</div>
                    <div className="text-[11px] text-muted-foreground">{p.type}</div>
                  </div>
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <p.icon className={`w-3 h-3 ${p.color}`} />
                    {p.badge}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
          <p className="text-[11px] text-muted-foreground mt-2 px-1">
            Eligibility: ₦2,000+ wagered AND 5+ resolved bets in the cycle.
          </p>
        </div>

        {/* Daily prizes */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-emerald-400" />
            <h3 className="text-base font-semibold">Daily Prize Pool</h3>
            <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-300">
              Resets midnight WAT
            </Badge>
          </div>
          <Card>
            <CardContent className="p-0 divide-y divide-border/40">
              {DAILY_PRIZES.map((p) => (
                <div key={p.rank} className="flex items-center gap-3 p-3">
                  <div className="w-10 text-center font-bold tabular-nums text-sm">
                    #{p.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{p.reward}</div>
                    <div className="text-[11px] text-muted-foreground">{p.label}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          <p className="text-[11px] text-muted-foreground mt-2 px-1">
            Eligibility: 3+ resolved bets in the day.
          </p>
        </div>

        {/* How points work */}
        <Card className="bg-card/40 border-muted/40">
          <CardContent className="p-5 space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-400" />
              How Points Are Earned
            </h3>
            <ul className="text-xs text-muted-foreground space-y-1.5 list-disc pl-5">
              <li><span className="text-foreground font-medium">Wagering:</span> 1 pt per ₦250 staked (a ₦1,000 bet = 4 pts).</li>
              <li><span className="text-foreground font-medium">Winning:</span> 1 pt per ₦100 of profit on resolved bets.</li>
              <li><span className="text-foreground font-medium">Normal referral:</span> 200 pts + ₦200 bonus credits per signup.</li>
              <li><span className="text-foreground font-medium">VIP referral:</span> 1,000 pts + rake share from referee&apos;s losing bets.</li>
            </ul>
            <p className="text-[10px] text-muted-foreground/80 pt-2">
              Cash prizes require KYC. Bonus credits must be wagered through 1× before withdrawal.
              Full T&amp;Cs at <a href="/terms" className="underline">/terms</a>.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
