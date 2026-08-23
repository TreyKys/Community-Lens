'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Gift, Loader2, Check, Clock, Phone, ExternalLink } from 'lucide-react';

// One-off profile rewards: phone number and four social follows.
//
// The phone reward is COLLECTED now and PAID on verification, and the card
// says so in as many words. Showing "₦200" next to a button that pays nothing
// today would be a promise the product cannot keep this week, and a user who
// discovers that themselves has been misled by omission.
//
// Social claims ask for the handle before paying. Nothing can check a follow —
// neither platform exposes it — so the handle is the entire audit trail, and
// asking for it is also the only friction standing between a throwaway account
// and ₦400.

type Reward = {
  id: string; label: string; detail: string; rewardTngn: number;
  needsHandle: boolean; url: string | null;
  status: 'available' | 'pending' | 'paid' | 'revoked';
  handle: string | null;
};

export function RewardsCard() {
  const { toast } = useToast();
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [value, setValue] = useState('');

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }
      const r = await fetch('/api/rewards', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const d = await r.json();
      if (r.ok) setRewards(d.rewards || []);
    } catch { /* card simply does not render */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const claim = async (rw: Reward) => {
    setBusy(rw.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch('/api/rewards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          rewardId: rw.id,
          ...(rw.id === 'phone' ? { phone: value } : { handle: value }),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not claim');

      toast(d.status === 'pending'
        ? {
            title: 'Number saved',
            description: `₦${d.rewardTngn} is waiting — we'll add it once your number is verified.`,
          }
        : {
            title: `₦${d.rewardTngn} bonus added`,
            description: 'Bonus credit — stake it to turn it into winnings.',
          });
      setOpen(null); setValue('');
      load();
    } catch (e: any) {
      toast({ title: 'Not claimed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  };

  if (loading) return null;

  const available = rewards.filter(r => r.status === 'available');
  // Nothing left to earn and nothing pending — the card has no job. Showing a
  // wall of ticks is just clutter on the screen people check their money on.
  if (available.length === 0 && !rewards.some(r => r.status === 'pending')) return null;

  const totalAvailable = available.reduce((s, r) => s + r.rewardTngn, 0);

  return (
    <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Gift className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold">Free bonus</h2>
          </div>
          {totalAvailable > 0 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
              ₦{totalAvailable.toLocaleString()} to claim
            </span>
          )}
        </div>

        <div className="space-y-2">
          {rewards.filter(r => r.status !== 'revoked').map(rw => (
            <div key={rw.id} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex items-center gap-1.5">
                  {rw.id === 'phone' && <Phone className="w-3 h-3 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-none truncate">{rw.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                      {rw.status === 'pending'
                        ? 'Waiting on verification — we’ll add it automatically'
                        : rw.detail}
                    </p>
                  </div>
                </div>

                {rw.status === 'paid' ? (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                    <Check className="w-3 h-3" /> Done
                  </span>
                ) : rw.status === 'pending' ? (
                  <span className="flex items-center gap-1 text-[10px] text-amber-300 shrink-0">
                    <Clock className="w-3 h-3" /> ₦{rw.rewardTngn} held
                  </span>
                ) : (
                  <Button size="sm"
                          className="h-7 px-2.5 text-[11px] bg-emerald-600 hover:bg-emerald-500 shrink-0"
                          onClick={() => { setOpen(open === rw.id ? null : rw.id); setValue(''); }}>
                    ₦{rw.rewardTngn}
                  </Button>
                )}
              </div>

              {open === rw.id && rw.status === 'available' && (
                <div className="space-y-1.5 pl-0.5">
                  {/* Opening the profile first, then asking for the handle,
                      mirrors the order the user actually does it in. */}
                  {rw.url && (
                    <a href={rw.url} target="_blank" rel="noopener noreferrer"
                       className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:underline">
                      Open the profile <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  <div className="flex gap-1.5">
                    <Input
                      value={value}
                      onChange={e => setValue(e.target.value)}
                      className="h-8 text-xs"
                      inputMode={rw.id === 'phone' ? 'tel' : 'text'}
                      placeholder={rw.id === 'phone' ? '08031234567' : '@yourhandle'}
                    />
                    <Button size="sm" className="h-8 text-[11px] shrink-0"
                            disabled={busy === rw.id || value.trim().length < 2}
                            onClick={() => claim(rw)}>
                      {busy === rw.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Claim'}
                    </Button>
                  </div>
                  {rw.id === 'phone' && (
                    <p className="text-[10px] text-muted-foreground">
                      We&rsquo;ll save it now and add the ₦{rw.rewardTngn} once it&rsquo;s verified.
                      One account per number.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="text-[10px] text-muted-foreground">
          Bonus credit — stake it to turn it into winnings.
        </p>
      </CardContent>
    </Card>
  );
}
