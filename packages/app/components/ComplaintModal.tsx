'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Loader2, CheckCircle2, HelpCircle, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MyComplaintsDialog } from './MyComplaintsDialog';

// The "Something wrong?" modal. Opened from any page that needs it —
// bets page, wallet page, market detail. Auto-attaches context so the
// server side has a snapshot of what the user was looking at when they
// filed.

export interface ComplaintContext {
  page?: string;
  betId?: string;
  slipId?: string;
  marketId?: number;
  extra?: Record<string, any>;
}

const TYPES: Array<{ id: 'bet_stuck' | 'deposit_missing' | 'withdrawal_delayed' | 'balance_wrong' | 'other'; label: string; hint: string }> = [
  { id: 'bet_stuck',            label: 'A prediction / slip isn’t resolving', hint: 'Placed a bet or Multiplier and it&apos;s still active after the event finished.' },
  { id: 'deposit_missing',      label: 'Deposit missing',                          hint: 'You paid in but your balance didn&apos;t go up.' },
  { id: 'withdrawal_delayed',   label: 'Withdrawal delayed',                       hint: 'Withdrawal request has been pending too long.' },
  { id: 'balance_wrong',        label: 'Balance looks wrong',                      hint: 'Balance doesn&apos;t match what you expect.' },
  { id: 'other',                label: 'Something else',                           hint: 'Not any of the above.' },
];

export function ComplaintModal({
  open,
  onOpenChange,
  context,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  context?: ComplaintContext;
}) {
  const { toast } = useToast();
  const [type, setType] = useState<string>('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ referenceCode: string; message: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Reset when the modal closes.
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setType('');
        setDescription('');
        setSubmitted(null);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const submit = async () => {
    if (!type) {
      toast({ title: 'Pick a category first', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in first.');

      const body = {
        type,
        description: description.trim() || null,
        relatedBetId: context?.betId,
        relatedSlipId: context?.slipId,
        relatedMarketId: context?.marketId,
        context: {
          page: context?.page || (typeof window !== 'undefined' ? window.location.pathname : undefined),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
          ...(context?.extra || {}),
        },
      };
      const r = await fetch('/api/user/complaint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSubmitted({ referenceCode: data.referenceCode, message: data.message });
    } catch (e: any) {
      toast({ title: 'Couldn&apos;t submit', description: e.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {!submitted ? (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <DialogTitle>Something wrong?</DialogTitle>
                  <DialogDescription>
                    Tell us what happened. We&apos;ll look at it right away and follow up in the app.
                  </DialogDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-[10px] gap-1 shrink-0"
                  onClick={() => setHistoryOpen(true)}
                >
                  <MessageCircle className="w-3 h-3" />
                  Past reports
                </Button>
              </div>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  What&apos;s the issue?
                </Label>
                <div className="space-y-1.5">
                  {TYPES.map(t => {
                    const selected = type === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setType(t.id)}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded-md border transition-colors',
                          selected ? 'border-emerald-500 bg-emerald-500/10' : 'border-muted hover:bg-muted/40',
                        )}
                      >
                        <div className="text-xs font-medium">{t.label}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{t.hint}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Anything else we should know? (optional)
                </Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Slip #ABC placed yesterday, all matches finished, still shows active."
                  className="text-sm min-h-[80px]"
                  maxLength={2000}
                />
              </div>

              <div className="text-[10px] text-muted-foreground flex items-start gap-1.5">
                <HelpCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  We&apos;ll automatically include your account, the page you&apos;re on, and any relevant bet or slip so we can investigate immediately. No screenshot needed.
                </span>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
              <Button className="bg-emerald-600 hover:bg-emerald-500 gap-2" onClick={submit} disabled={!type || submitting}>
                {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Submit
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                Got it — reference {submitted.referenceCode}
              </DialogTitle>
              <DialogDescription>{submitted.message}</DialogDescription>
            </DialogHeader>
            <div className="text-xs text-muted-foreground bg-muted/20 border rounded-md p-3">
              We&apos;ll notify you here as soon as it&apos;s addressed. If you need to follow up, quote reference <strong className="font-mono">{submitted.referenceCode}</strong>.
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setHistoryOpen(true)}>
                See past reports
              </Button>
              <Button onClick={() => onOpenChange(false)} className="gap-2">Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>

      <MyComplaintsDialog open={historyOpen} onOpenChange={setHistoryOpen} />
    </Dialog>
  );
}
