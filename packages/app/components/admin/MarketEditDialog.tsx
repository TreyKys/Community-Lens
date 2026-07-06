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
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Trash2, AlertTriangle, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

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
  // ── Locked-odds conversion gating ────────────────────────────────
  // Read so the dialog can decide whether to surface the migration
  // section. Converting an already-locked, post-lock, or already-staked
  // market is unsafe (see /api/admin/markets/[id] PATCH for the full
  // rule set); we hide the UI in those cases.
  is_locked_odds: boolean;
  status: string;
  total_bets: number;
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

  // ── Locked-odds conversion state ─────────────────────────────────
  // Optional migration of a legacy parimutuel market to the locked-
  // odds engine. Only surfaced when the market is eligible (see
  // MarketShape comments). Defaults preserve the current engine.
  const [convertToLocked, setConvertToLocked] = useState(false);
  const [convSeedSize, setConvSeedSize] = useState('10000');
  const [convSeedProbability, setConvSeedProbability] = useState('0.5');
  const [convSeedProbsMulti, setConvSeedProbsMulti] = useState<string[]>([]);
  const [convVigOverride, setConvVigOverride] = useState('');
  const [reserveDeployable, setReserveDeployable] = useState<number | null>(null);

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
          is_locked_odds: !!m.is_locked_odds,
          status: m.status ?? 'open',
          total_bets: Number(body?.summary?.total_bets ?? 0),
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

        // Reset conversion form to defaults each time we open a market.
        // Default seedProbsMulti to a uniform split that sums to 1.00.
        setConvertToLocked(false);
        setConvSeedSize('10000');
        setConvSeedProbability('0.5');
        setConvVigOverride('');
        const n = opts.length;
        if (n >= 3) {
          const uniform = Math.floor((1 / n) * 100) / 100;
          const arr = Array.from({ length: n }, () => uniform.toFixed(2));
          arr[n - 1] = (uniform + (1 - uniform * n)).toFixed(2);
          setConvSeedProbsMulti(arr);
        } else {
          setConvSeedProbsMulti([]);
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || 'Failed to load market');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, marketId]);

  // Reserve hint for the conversion section. Loaded only when the
  // admin toggles the migration on — keeps the dialog cheap when the
  // section stays collapsed. Goes through the admin server endpoint
  // because reserve_health is now security_invoker = on and house_
  // reserve is service-role only — a direct client read returns null.
  useEffect(() => {
    if (!convertToLocked) return;
    fetch('/api/admin/reserve-health')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && typeof data.deployable !== 'undefined') {
          setReserveDeployable(Number(data.deployable));
        }
      })
      .catch(() => { /* leave hint unset on failure */ });
  }, [convertToLocked]);

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
    if (options.length >= 50) {
      toast({ title: 'Max 50 options per market', variant: 'destructive' });
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

    // Build the locked-odds conversion payload, if the admin opted in.
    // We do the same client-side validation as the create-market form so
    // bad input doesn't round-trip — server re-validates regardless.
    if (convertToLocked && market) {
      const seedSizeNum = Number(convSeedSize);
      if (!Number.isFinite(seedSizeNum) || seedSizeNum < 1_000 || seedSizeNum > 14_000) {
        toast({ title: 'Seed size must be ₦1,000–₦14,000', variant: 'destructive' });
        return;
      }
      const numOutcomes = cleanedOpts.length;
      let convSeedPool: number[] | null = null;
      let convBinaryProb: number | null = null;
      if (numOutcomes === 2) {
        const p = Number(convSeedProbability);
        if (!Number.isFinite(p) || p < 0.05 || p > 0.95) {
          toast({ title: 'Seed probability must be between 0.05 and 0.95', variant: 'destructive' });
          return;
        }
        convBinaryProb = p;
      } else {
        const probs = convSeedProbsMulti.slice(0, numOutcomes).map(s => Number(s));
        const sum = probs.reduce((a, p) => a + (Number.isFinite(p) ? p : 0), 0);
        if (!probs.every(p => Number.isFinite(p) && p >= 0.02 && p <= 0.98) || Math.abs(sum - 1) > 0.005) {
          toast({
            title: 'Seed probabilities invalid',
            description: 'Each outcome must be 0.02–0.98 and they must sum to 1.00.',
            variant: 'destructive',
          });
          return;
        }
        const raw = probs.map(p => Math.round(seedSizeNum * p));
        const drift = seedSizeNum - raw.reduce((a, v) => a + v, 0);
        raw[0] += drift;
        convSeedPool = raw;
      }
      let convVigNum: number | null = null;
      if (convVigOverride.trim() !== '') {
        const v = Number(convVigOverride);
        if (!Number.isFinite(v) || v < 0.04 || v > 0.15) {
          toast({ title: 'Vig must be between 0.04 and 0.15', variant: 'destructive' });
          return;
        }
        convVigNum = v;
      }
      patch.convertToLockedOdds = {
        seedSizeTngn: seedSizeNum,
        seedPool: convSeedPool,
        seedProbability: convBinaryProb,
        vigPct: convVigNum,
      };
    }

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
                placeholder="e.g. World Cup Golden Boot"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="m-question">Question</Label>
              <Textarea
                id="m-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={4}
                className="resize-y"
                placeholder={'Will Nigeria show up in 2027?\n\nPress Enter for a new line — line breaks are preserved on the market card.'}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="m-desc">Description / about</Label>
              <Textarea
                id="m-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                className="resize-y"
                placeholder="Context shown in the About-this-market drawer. Line breaks are preserved."
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
                  disabled={options.length >= 50}
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
                        'space-y-1 rounded-md border px-2 py-1.5',
                        locked ? 'border-amber-500/30 bg-amber-500/[0.04]' : 'border-border/60',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium text-muted-foreground">Option {idx + 1}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                            {bets} bet{bets === 1 ? '' : 's'} · ₦{pool.toLocaleString()}
                          </span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => removeOption(idx)}
                            disabled={locked || options.length <= 2}
                            title={locked ? 'Has stakes — rename only' : (options.length <= 2 ? 'Need at least 2 options' : 'Remove option')}
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-30"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                      <Textarea
                        value={opt}
                        onChange={(e) => updateOption(idx, e.target.value)}
                        placeholder={`Option ${idx + 1}`}
                        rows={2}
                        className="resize-y"
                      />
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

            {/* ── Migrate legacy market → locked-odds ───────────────────
                Selectively converts a parimutuel market created before
                the locked-odds engine landed. Only surfaced when the
                market is still parimutuel, still open, and has zero
                bets — the server enforces the same gating, but hiding
                the UI keeps the dialog uncluttered for the 95% of
                markets where this doesn't apply. */}
            {!market.is_locked_odds && market.status === 'open' && (
              <ConvertToLockedOddsSection
                eligible={market.total_bets === 0}
                totalBets={market.total_bets}
                numOutcomes={options.length}
                convertToLocked={convertToLocked}
                setConvertToLocked={setConvertToLocked}
                seedSize={convSeedSize}
                setSeedSize={setConvSeedSize}
                seedProbability={convSeedProbability}
                setSeedProbability={setConvSeedProbability}
                seedProbsMulti={convSeedProbsMulti}
                setSeedProbsMulti={setConvSeedProbsMulti}
                vigOverride={convVigOverride}
                setVigOverride={setConvVigOverride}
                reserveDeployable={reserveDeployable}
              />
            )}

            {market.is_locked_odds && (
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2 text-[11px] text-emerald-300/90 flex items-center gap-2">
                <Zap className="w-3.5 h-3.5" />
                <span>This market already runs on the locked-odds engine.</span>
              </div>
            )}
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

// ── Locked-odds migration section ───────────────────────────────────
//
// Mirror of the create-market form's LockedOddsConfigBlock, scoped to
// the in-flight market being edited. Renders a checkbox; when checked,
// surfaces seed size + per-outcome probability inputs + vig override
// and a split preview. The actual conversion happens server-side via
// the PATCH endpoint, which re-validates and enforces the
// no-existing-bets gate before flipping is_locked_odds.
function ConvertToLockedOddsSection(props: {
  eligible: boolean;
  totalBets: number;
  numOutcomes: number;
  convertToLocked: boolean;
  setConvertToLocked: (v: boolean) => void;
  seedSize: string;
  setSeedSize: (v: string) => void;
  seedProbability: string;
  setSeedProbability: (v: string) => void;
  seedProbsMulti: string[];
  setSeedProbsMulti: (v: string[] | ((prev: string[]) => string[])) => void;
  vigOverride: string;
  setVigOverride: (v: string) => void;
  reserveDeployable: number | null;
}) {
  const {
    eligible, totalBets, numOutcomes,
    convertToLocked, setConvertToLocked,
    seedSize, setSeedSize,
    seedProbability, setSeedProbability,
    seedProbsMulti, setSeedProbsMulti,
    vigOverride, setVigOverride,
    reserveDeployable,
  } = props;

  const seedSizeNum = Number(seedSize);
  const seedProbNum = Number(seedProbability);
  const vigNum = vigOverride.trim() === '' ? undefined : Number(vigOverride);
  const validSeed = Number.isFinite(seedSizeNum) && seedSizeNum >= 1_000 && seedSizeNum <= 14_000;
  const validVig = vigNum === undefined || (Number.isFinite(vigNum) && vigNum >= 0.04 && vigNum <= 0.15);
  const seedFitsReserve = reserveDeployable == null || seedSizeNum <= reserveDeployable;

  const multiProbs = seedProbsMulti.slice(0, numOutcomes).map(s => Number(s));
  const multiProbSum = multiProbs.reduce((a, p) => a + (Number.isFinite(p) ? p : 0), 0);
  const validMultiProbs =
    numOutcomes < 3
      ? true
      : multiProbs.length === numOutcomes
        && multiProbs.every(p => Number.isFinite(p) && p >= 0.02 && p <= 0.98)
        && Math.abs(multiProbSum - 1) <= 0.005;
  const validProb =
    numOutcomes === 2
      ? (Number.isFinite(seedProbNum) && seedProbNum >= 0.05 && seedProbNum <= 0.95)
      : validMultiProbs;

  const splitPreview: number[] = (() => {
    if (!validSeed || numOutcomes < 2) return [];
    if (numOutcomes === 2) {
      if (!validProb) return [];
      const yes = Math.round(seedSizeNum * seedProbNum);
      return [yes, seedSizeNum - yes];
    }
    if (validMultiProbs) {
      const raw = multiProbs.map(p => Math.round(seedSizeNum * p));
      const drift = seedSizeNum - raw.reduce((a, v) => a + v, 0);
      raw[0] += drift;
      return raw;
    }
    return [];
  })();

  if (!eligible) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-xs font-medium">Locked-odds migration unavailable</p>
            <p className="text-[11px] text-muted-foreground">
              This market already has {totalBets} bet{totalBets === 1 ? '' : 's'} on it.
              Conversion is only allowed before any user has staked — flipping the engine
              mid-market would either strand existing bets or rewrite their price.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] p-3 space-y-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={convertToLocked}
          onChange={e => setConvertToLocked(e.target.checked)}
          className="w-4 h-4 accent-emerald-500"
        />
        <span className="text-sm font-medium">Migrate to locked-odds engine</span>
        <Badge variant="outline" className="text-[9px] border-emerald-500/30 text-emerald-300">
          PRO TIER
        </Badge>
      </label>
      <p className="text-[11px] text-muted-foreground -mt-2 ml-6">
        Seeds the market with house tNGN at the chosen probabilities and switches
        future bets to the locked-odds engine. Reversible only by manual SQL.
      </p>

      {convertToLocked && (
        <div className="space-y-3 ml-6 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Seed size (₦)</Label>
              <Input
                type="number"
                min={1000}
                max={14000}
                value={seedSize}
                onChange={e => setSeedSize(e.target.value)}
                className={cn(!validSeed && 'border-red-500/40')}
              />
              <p className="text-[10px] text-muted-foreground">
                ₦1k – ₦14k.{' '}
                {reserveDeployable != null && (
                  <span className={seedFitsReserve ? 'text-emerald-400' : 'text-red-400'}>
                    Reserve: ₦{reserveDeployable.toLocaleString()} available.
                  </span>
                )}
              </p>
            </div>
            {numOutcomes === 2 && (
              <div className="space-y-1">
                <Label className="text-xs">Seed probability (YES, 0–1)</Label>
                <Input
                  type="number"
                  min={0.05}
                  max={0.95}
                  step={0.01}
                  value={seedProbability}
                  onChange={e => setSeedProbability(e.target.value)}
                  className={cn(!validProb && 'border-red-500/40')}
                />
                <p className="text-[10px] text-muted-foreground">
                  {validProb && validSeed && splitPreview.length === 2 && (
                    <>Split: ₦{splitPreview[0].toLocaleString()} YES · ₦{splitPreview[1].toLocaleString()} NO</>
                  )}
                </p>
              </div>
            )}
          </div>

          {numOutcomes >= 3 && (
            <div className="space-y-2">
              <Label className="text-xs">Seed probability per outcome (must sum to 1.00)</Label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {Array.from({ length: numOutcomes }).map((_, i) => (
                  <div key={i} className="space-y-1">
                    <p className="text-[10px] text-muted-foreground">Outcome {i}</p>
                    <Input
                      type="number"
                      step={0.01}
                      min={0.02}
                      max={0.98}
                      value={seedProbsMulti[i] ?? ''}
                      onChange={e => setSeedProbsMulti(prev => {
                        const next = prev.slice(0, numOutcomes);
                        while (next.length < numOutcomes) next.push('');
                        next[i] = e.target.value;
                        return next;
                      })}
                      className={cn(!validMultiProbs && 'border-red-500/40')}
                    />
                  </div>
                ))}
              </div>
              <p className={cn(
                'text-[10px]',
                Math.abs(multiProbSum - 1) > 0.005 ? 'text-red-400' : 'text-muted-foreground',
              )}>
                Sum: {multiProbSum.toFixed(3)}{' '}
                {Math.abs(multiProbSum - 1) > 0.005 && '— must equal 1.000'}
              </p>
              {validMultiProbs && validSeed && splitPreview.length === numOutcomes && (
                <p className="text-[10px] text-muted-foreground">
                  Split: {splitPreview.map((v, i) => `₦${v.toLocaleString()} (#${i})`).join(' · ')}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Vig override (0.04–0.15, blank = category default)</Label>
            <Input
              type="number"
              min={0.04}
              max={0.15}
              step={0.01}
              value={vigOverride}
              onChange={e => setVigOverride(e.target.value)}
              placeholder="default for category"
              className={cn(!validVig && 'border-red-500/40')}
            />
          </div>

          {!seedFitsReserve && (
            <p className="text-[11px] text-red-400">
              Seed exceeds deployable reserve. Reduce seed size or settle a market first.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
