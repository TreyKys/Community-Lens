'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

// Admin "edit anything" dialog for an already-created market. Loads the
// full market on open, lets admin edit text + options, then PATCHes via
// /api/admin/markets/[id]. The server side enforces the bet-safety
// rules (can't remove an option that has stakes on it); we additionally
// fetch a per-outcome bet count up-front and visually disable removal
// for outcomes that have any stakes — so the admin sees the constraint
// before they try to violate it, rather than getting a 409 toast.
//
// Pool values themselves are deliberately not surfaced — admins asked
// for edit power but explicitly NOT for pool tampering.

function adminHeaders() {
  return { 'Content-Type': 'application/json' };
}

interface Props {
  marketId: number | null;
  onClose: () => void;
  // Called after a successful save so the parent list can refresh
  // without us coupling to its loader.
  onSaved?: () => void;
}

type MarketShape = {
  id: number;
  title: string | null;
  question: string;
  description: string | null;
  category: string | null;
  closes_at: string | null;
  options: string[];
  // pool_by_outcome read for the "has stakes" hint but never edited.
  pool_by_outcome: number[];
};

// Convert an ISO timestamp to the value format <input type="datetime-local">
// accepts (YYYY-MM-DDTHH:mm in LOCAL time).
function toLocalDatetimeInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function MarketEditDialog({ marketId, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const open = marketId !== null;

  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketShape | null>(null);

  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [closesAtLocal, setClosesAtLocal] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  // Per-outcome bet counts so we can tell the admin which options are
  // "locked from removal." Indexed parallel to options[].
  const [betsByOutcome, setBetsByOutcome] = useState<number[]>([]);
  const [poolByOutcome, setPoolByOutcome] = useState<number[]>([]);

  // Load market detail when the dialog opens. We use the existing
  // /api/admin/markets/[id] GET which returns the full forensic dossier;
  // we only need a slice but the endpoint is cheap and already wired.
  useEffect(() => {
    if (!open || marketId === null) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    (async () => {
      try {
        const res = await fetch(`/api/admin/markets/${marketId}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || 'Failed to load market');
        if (cancelled) return;

        const m = body.market;
        const opts: string[] = Array.isArray(m.options) ? m.options : [];
        const pool: number[] = Array.isArray(m.pool_by_outcome) ? m.pool_by_outcome : [];
        // /api/admin/markets/[id] returns distribution positionally
        // aligned with options — index i in distribution corresponds
        // to outcome index i. Field is `bet_count` (singular).
        const distribution: Array<{ bet_count: number }> = Array.isArray(body.distribution) ? body.distribution : [];

        const counts: number[] = opts.map((_, i) => Number(distribution[i]?.bet_count || 0));

        const shaped: MarketShape = {
          id: m.id,
          title: m.title ?? null,
          question: m.question ?? '',
          description: m.description ?? null,
          category: m.category ?? null,
          closes_at: m.closes_at ?? null,
          options: opts,
          pool_by_outcome: pool,
        };
        setMarket(shaped);
        setTitle(shaped.title ?? '');
        setQuestion(shaped.question);
        setDescription(shaped.description ?? '');
        setCategory(shaped.category ?? '');
        setClosesAtLocal(toLocalDatetimeInput(shaped.closes_at));
        setOptions(opts);
        setBetsByOutcome(counts);
        setPoolByOutcome(pool);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || 'Failed to load market');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, marketId]);

  const updateOption = (idx: number, value: string) => {
    setOptions(prev => prev.map((o, i) => (i === idx ? value : o)));
  };

  const removeOption = (idx: number) => {
    // Server enforces this too; we mirror locally for instant feedback.
    if ((betsByOutcome[idx] || 0) > 0) {
      toast({
        title: 'Cannot remove',
        description: 'This option already has stakes. Rename it instead.',
        variant: 'destructive',
      });
      return;
    }
    setOptions(prev => prev.filter((_, i) => i !== idx));
    setBetsByOutcome(prev => prev.filter((_, i) => i !== idx));
    setPoolByOutcome(prev => prev.filter((_, i) => i !== idx));
  };

  const addOption = () => {
    if (options.length >= 10) {
      toast({ title: 'Max 10 options', variant: 'destructive' });
      return;
    }
    setOptions(prev => [...prev, '']);
    setBetsByOutcome(prev => [...prev, 0]);
    setPoolByOutcome(prev => [...prev, 0]);
  };

  const handleSave = async () => {
    if (marketId === null || !market) return;

    // Pre-flight: trim + validate option labels client-side so the most
    // common "I forgot to fill that one in" mistakes never reach the
    // server. Server re-validates regardless.
    const cleanedOpts = options.map(o => o.trim()).filter(s => s.length > 0);
    if (cleanedOpts.length < 2) {
      toast({ title: 'Need at least 2 options', variant: 'destructive' });
      return;
    }

    // Build a minimal patch — only send fields that actually changed.
    // Keeps audit-noise low and avoids round-tripping the pool array
    // when options didn't change.
    const patch: Record<string, unknown> = {};
    if (title.trim() !== (market.title ?? '')) patch.title = title.trim();
    if (question.trim() !== market.question) patch.question = question.trim();
    if (description !== (market.description ?? '')) {
      patch.description = description.trim() || null;
    }
    if (category.trim() !== (market.category ?? '')) patch.category = category.trim();
    const newIso = fromLocalDatetimeInput(closesAtLocal);
    if (newIso && newIso !== market.closes_at) patch.closes_at = newIso;

    const optionsChanged =
      cleanedOpts.length !== market.options.length ||
      cleanedOpts.some((v, i) => v !== market.options[i]);
    if (optionsChanged) patch.options = cleanedOpts;

    if (Object.keys(patch).length === 0) {
      toast({ title: 'No changes', description: 'Nothing to save.' });
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch(`/api/admin/markets/${marketId}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Save failed');
      toast({ title: 'Market updated', description: `#${marketId} saved` });
      onSaved?.();
      onClose();
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message || 'Unknown error', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isSaving) onClose(); }}>
      <DialogContent className="sm:max-w-[560px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit market #{marketId ?? ''}</DialogTitle>
          <DialogDescription>
            Text and options can be edited freely. Removing an option is blocked once anyone has staked on it.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {loadError && !isLoading && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loadError}
          </div>
        )}

        {!isLoading && !loadError && market && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="m-title">Short title</Label>
              <Input
                id="m-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="e.g. World Cup Golden Boot"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="m-question">Question</Label>
              <Textarea
                id="m-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Will Nigeria show up in 2027?"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="m-desc">Description / about</Label>
              <Textarea
                id="m-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Context shown in the About-this-market drawer."
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="m-category">Category</Label>
                <Input
                  id="m-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="sports / politics / economy / crypto"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-closes">Closes at</Label>
                <Input
                  id="m-closes"
                  type="datetime-local"
                  value={closesAtLocal}
                  onChange={(e) => setClosesAtLocal(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Outcome options</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addOption}
                  disabled={options.length >= 10}
                  className="h-7 text-xs gap-1"
                >
                  <Plus className="w-3 h-3" /> Add
                </Button>
              </div>
              <div className="space-y-2">
                {options.map((opt, idx) => {
                  const bets = betsByOutcome[idx] || 0;
                  const pool = Math.round(poolByOutcome[idx] || 0);
                  const locked = bets > 0;
                  return (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2 py-1.5',
                        locked ? 'border-amber-500/30 bg-amber-500/[0.04]' : 'border-border/60',
                      )}
                    >
                      <span className="text-[10px] tabular-nums text-muted-foreground w-6 text-right">#{idx}</span>
                      <Input
                        value={opt}
                        onChange={(e) => updateOption(idx, e.target.value)}
                        maxLength={80}
                        placeholder={`Option ${idx + 1}`}
                        className="h-8 flex-1"
                      />
                      <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap min-w-[88px] text-right">
                        {bets} bet{bets === 1 ? '' : 's'} · ₦{pool.toLocaleString()}
                      </span>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => removeOption(idx)}
                        disabled={locked || options.length <= 2}
                        title={locked ? 'Has stakes — rename only' : (options.length <= 2 ? 'Need at least 2 options' : 'Remove option')}
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-30"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
              {options.some((_, i) => (betsByOutcome[i] || 0) > 0) && (
                <p className="text-[11px] text-amber-300/90 flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  Options with stakes can only be renamed — removal would leave users&rsquo; bets pointing nowhere.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
          <Button onClick={handleSave} disabled={isLoading || isSaving || !market}>
            {isSaving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving…</> : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
