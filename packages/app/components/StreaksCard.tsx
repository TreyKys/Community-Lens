'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Flame, Gift, Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// Streaks.
//
// Shows PROGRESS, not just completion. A reward that only appears once earned
// motivates nobody — the bar sitting at 5 of 7 is the thing that brings
// someone back tomorrow, and it is the only part of this component that has to
// be right.
//
// Ordered so the nearest finish line is first. Someone on 6/7 and 1/30 should
// see the 6/7; sorting by definition order would bury the reason to come back
// under four bars they have barely started.
//
// Rewards are bonus credit, and the copy says so. A user who believes they
// earned withdrawable cash and discovers otherwise at the withdraw screen has
// been misled by omission, whatever the terms say.

type Streak = {
  id: string; label: string; detail: string;
  progress: number; target: number; rewardTngn: number;
  claimable: boolean; claimed: boolean;
};

export function StreaksCard() {
  const { toast } = useToast();
  const [streaks, setStreaks] = useState<Streak[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }
      const r = await fetch('/api/streaks', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const d = await r.json();
      if (r.ok) setStreaks(d.streaks || []);
    } catch { /* the card simply does not render */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const claim = async (s: Streak) => {
    setBusy(s.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch('/api/streaks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ streakId: s.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not claim');
      toast({
        title: `₦${d.rewardTngn.toLocaleString()} bonus added`,
        description: 'Bonus credit — stake it to turn it into winnings.',
      });
      load();
    } catch (e: any) {
      toast({ title: 'Not claimed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  if (loading || streaks.length === 0) return null;

  // Nearest finish line first, but anything CLAIMABLE jumps the queue — money
  // waiting to be collected outranks progress toward more of it.
  const sorted = [...streaks].sort((a, b) => {
    if (a.claimable !== b.claimable) return a.claimable ? -1 : 1;
    if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
    return (b.progress / b.target) - (a.progress / a.target);
  });

  const ready = sorted.filter(s => s.claimable).length;

  return (
    <Card className="border-amber-500/20 bg-amber-500/[0.03]">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Flame className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold">Streaks</h2>
          </div>
          {ready > 0 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
              {ready} ready
            </span>
          )}
        </div>

        <div className="space-y-2.5">
          {sorted.map(s => (
            <div key={s.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium leading-none">{s.label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{s.detail}</p>
                </div>

                {s.claimed ? (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                    <Check className="w-3 h-3" /> Claimed
                  </span>
                ) : s.claimable ? (
                  <Button size="sm" disabled={busy === s.id}
                          className="h-7 px-2.5 text-[11px] bg-emerald-600 hover:bg-emerald-500 shrink-0"
                          onClick={() => claim(s)}>
                    {busy === s.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <><Gift className="w-3 h-3 mr-1" />₦{s.rewardTngn.toLocaleString()}</>}
                  </Button>
                ) : (
                  <span className="text-[10px] text-muted-foreground tabular shrink-0">
                    {s.progress}/{s.target} · ₦{s.rewardTngn.toLocaleString()}
                  </span>
                )}
              </div>

              <div className="h-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-500',
                    s.claimed ? 'bg-muted-foreground/40'
                      : s.claimable ? 'bg-emerald-500' : 'bg-amber-500/70',
                  )}
                  style={{ width: `${Math.min(100, (s.progress / s.target) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-muted-foreground pt-0.5">
          Rewards are bonus credit — stake it to turn it into winnings.
        </p>
      </CardContent>
    </Card>
  );
}
