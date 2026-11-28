'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ChevronLeft, ShieldAlert, RefreshCw, Plus, Trash2, AlertTriangle } from 'lucide-react';

// Admin surface for The Run.
//
// The brief was "control everything, but don't make it complex". So: a preset
// fills in every pricing number, the five fixtures are the only thing you
// normally type, and the page continuously shows what the card MEANS — the
// margin on each fixture and what it would really pay out — rather than making
// an admin hold the maths in their head.

const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`;

type Leg = { fixture: string; kickoff_at: string | null; odds_w: number | string;
             odds_d: number | string; odds_l: number | string;
             result?: string | null; leg_index?: number };
type Run = {
  id: string; title: string; kind: string; status: string;
  rtp_target: number; decay: number; cashout_spread_pct: number;
  min_stake_tngn: number; max_stake_tngn: number;
  payout_cap_multiple: number; payout_cap_tngn: number;
  card_liability_cap_tngn: number; closes_at: string;
  legs: Leg[]; stats: { entries: number; staked: number; liability: number };
};

const BLANK_LEG: Leg = { fixture: '', kickoff_at: null, odds_w: '', odds_d: '', odds_l: '' };
const CONFIG_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'rtp_target',              label: 'Return to player', hint: '0.90 = you keep ~10%' },
  { key: 'decay',                   label: 'Miss decay',       hint: 'position kept per missed leg' },
  { key: 'cashout_spread_pct',      label: 'Cash-out spread',  hint: 'your cut on an early exit' },
  { key: 'min_stake_tngn',          label: 'Min stake',        hint: '' },
  { key: 'max_stake_tngn',          label: 'Max stake',        hint: 'per player, per card' },
  { key: 'payout_cap_multiple',     label: 'Payout cap (×)',   hint: 'multiple of stake' },
  { key: 'payout_cap_tngn',         label: 'Payout cap (₦)',   hint: 'hard ceiling per entry' },
  { key: 'card_liability_cap_tngn', label: 'Card liability cap', hint: 'card stops selling here' },
];

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const overround = (l: Leg) => {
  const w = num(l.odds_w), d = num(l.odds_d), s = num(l.odds_l);
  if (w <= 1 || d <= 1 || s <= 1) return 0;
  return 1 / w + 1 / d + 1 / s;
};
// Same formula as run_coefficient() in the database — shown here so an admin
// can see the price before publishing, not so anything is priced client-side.
function coefficient(odds: number[], ors: number[], rtp: number, decay: number) {
  let f = 1;
  for (let i = 0; i < odds.length; i++) {
    if (odds[i] <= 1 || ors[i] <= 0) return 0;
    const p = (1 / odds[i]) / ors[i];
    f *= p * odds[i] + (1 - p) * decay;
  }
  return f > 0 ? rtp / f : 0;
}

export default function AdminRunsPage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [presets, setPresets] = useState<any>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/auth').then(r => { if (r.ok) setIsAdmin(true); }).finally(() => setChecking(false));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/runs', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setRuns(d.runs || []); setPresets(d.presets || {});
    } catch (e: any) {
      toast({ title: 'Could not load', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const call = async (body: any, label: string) => {
    setBusy(label);
    try {
      const r = await fetch('/api/admin/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    } catch (e: any) {
      toast({ title: 'Not applied', description: e.message, variant: 'destructive' });
      return null;
    } finally { setBusy(null); }
  };

  if (checking) return <div className="flex items-center justify-center min-h-[60vh]">
    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  if (!isAdmin) return (
    <div className="max-w-sm mx-auto p-4 pt-16 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium"><ShieldAlert className="w-4 h-4" /> Admin access</div>
      <Input type="password" value={secret} placeholder="Admin secret"
             onChange={e => setSecret(e.target.value)}
             onKeyDown={async e => {
               if (e.key !== 'Enter') return;
               const r = await fetch('/api/admin/auth', { method: 'POST',
                 headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) });
               if (r.ok) setIsAdmin(true); else toast({ title: 'Invalid secret', variant: 'destructive' });
             }} />
    </div>
  );

  const startNew = (kind: 'mixed' | 'single_team') => setEditing({
    id: '', kind, title: '', closes_at: '',
    legs: [0, 1, 2, 3, 4].map(() => ({ ...BLANK_LEG })),
    config: { ...(presets[kind] || {}) }, showAdvanced: false,
  });

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Link href="/admin" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Admin
        </Link>
        <button onClick={load} disabled={loading}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div>
        <h1 className="text-xl font-bold">The Run</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Five fixtures, one stake. Pick a preset, type the fixtures and their odds — the rest is filled in.
        </p>
      </div>

      {!editing && (
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={() => startNew('mixed')} className="bg-emerald-600 hover:bg-emerald-500">
            <Plus className="w-4 h-4 mr-1" /> New Mixed Run
          </Button>
          <Button size="sm" variant="outline" onClick={() => startNew('single_team')}>
            <Plus className="w-4 h-4 mr-1" /> New Single-Team Run
          </Button>
        </div>
      )}

      {editing && <RunEditor editing={editing} setEditing={setEditing} presets={presets}
                             busy={busy} call={call} reload={load} />}

      {!editing && runs.map(r => (
        <RunRow key={r.id} run={r} busy={busy} call={call} reload={load} setEditing={setEditing} />
      ))}

      {!editing && runs.length === 0 && !loading && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          No Runs yet. Create one above.
        </CardContent></Card>
      )}
    </div>
  );
}

// ── Editor ────────────────────────────────────────────────────────────────
function RunEditor({ editing, setEditing, presets, busy, call, reload }: any) {
  const { toast } = useToast();
  const set = (patch: any) => setEditing({ ...editing, ...patch });
  const setLeg = (i: number, patch: any) => {
    const legs = editing.legs.slice(); legs[i] = { ...legs[i], ...patch }; set({ legs });
  };

  const rtp = num(editing.config.rtp_target), decay = num(editing.config.decay);
  const ors = editing.legs.map((l: Leg) => overround(l));
  const ready = editing.legs.every((l: Leg) => overround(l) > 0);

  // What the card actually pays, shown live. Favourite = shortest price on
  // each leg; longshot = longest. This is the sanity check that stops a card
  // going out with a 900x worst case nobody noticed.
  let example: null | { favK: number; favMax: number; longK: number; longMax: number } = null;
  if (ready) {
    const stake = num(editing.config.max_stake_tngn) || 1000;
    const net = stake * 0.985;
    const favOdds = editing.legs.map((l: Leg) => Math.min(num(l.odds_w), num(l.odds_d), num(l.odds_l)));
    const lngOdds = editing.legs.map((l: Leg) => Math.max(num(l.odds_w), num(l.odds_d), num(l.odds_l)));
    const favK = coefficient(favOdds, ors, rtp, decay);
    const lngK = coefficient(lngOdds, ors, rtp, decay);
    const cap = Math.min(num(editing.config.payout_cap_tngn), net * num(editing.config.payout_cap_multiple));
    example = {
      favK, longK: lngK,
      favMax: Math.min(net * favK * favOdds.reduce((a: number, b: number) => a * b, 1), cap),
      longMax: Math.min(net * lngK * lngOdds.reduce((a: number, b: number) => a * b, 1), cap),
    };
  }

  const save = async () => {
    const d = await call({
      action: 'save', id: editing.id || undefined, title: editing.title, kind: editing.kind,
      closes_at: editing.closes_at ? new Date(editing.closes_at).toISOString() : null,
      legs: editing.legs, config: editing.config,
    }, 'save');
    if (d) { toast({ title: 'Saved as draft' }); setEditing(null); reload(); }
  };

  return (
    <Card className="border-emerald-500/30">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">
            {editing.id ? 'Edit draft' : 'New Run'}
            <Badge variant="outline" className="ml-2 text-[9px] uppercase">{editing.kind.replace('_', ' ')}</Badge>
          </p>
          <button onClick={() => setEditing(null)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
        </div>

        {editing.kind === 'single_team' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-px" />
            <p className="text-[11px] text-amber-200/90">
              One team across five weeks isn&rsquo;t five independent results — form carries them together,
              which is why this preset pays far less. Prefer an <strong>erratic</strong> team.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">Title</p>
            <Input value={editing.title} placeholder="Premier League Run — Week 14"
                   onChange={e => set({ title: e.target.value })} className="h-8 text-xs" />
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground mb-1">Entries close</p>
            <Input type="datetime-local" value={editing.closes_at}
                   onChange={e => set({ closes_at: e.target.value })} className="h-8 text-xs" />
          </div>
        </div>

        {/* The five fixtures.
            Was a 5-column desktop table, which squeezed the fixture name to
            about 40px on a phone — you could type into it and see nothing.
            One stacked block per fixture instead: name on its own full-width
            row, the three prices under it. */}
        <div className="space-y-2">
          <div className="rounded-lg bg-muted/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              For each fixture, set the odds you&rsquo;re offering on the home team
              to <span className="text-foreground font-medium">Win</span>,{' '}
              <span className="text-foreground font-medium">Draw</span>, or{' '}
              <span className="text-foreground font-medium">Lose</span>.
              You set these yourself — <span className="text-foreground">they stay fixed</span> and
              do not move as people stake.
            </p>
          </div>

          {editing.legs.map((l: Leg, i: number) => {
            const or = ors[i];
            const bad = or > 0 && or < 1.0;
            const steep = or > 1.15;
            return (
              <div key={i} className="rounded-xl border border-border p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
                    Fixture {i + 1}
                  </span>
                  <span className={`text-[11px] tabular-nums font-bold ${
                    !or ? 'text-muted-foreground/40' : bad ? 'text-red-400'
                      : steep ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {or ? `margin ${(or * 100).toFixed(0)}%` : 'margin —'}
                  </span>
                </div>

                <Input value={l.fixture} placeholder="e.g. Arsenal vs Everton"
                       onChange={e => setLeg(i, { fixture: e.target.value })}
                       className="h-10 text-sm" />

                <div className="grid grid-cols-3 gap-2">
                  {([['odds_w', 'Win'], ['odds_d', 'Draw'], ['odds_l', 'Loss']] as const).map(([k, label]) => (
                    <div key={k}>
                      <p className="text-[10px] text-muted-foreground mb-1 text-center">{label}</p>
                      <Input value={l[k] as any} inputMode="decimal" placeholder="0.00"
                             onChange={e => setLeg(i, { [k]: e.target.value })}
                             className="h-10 text-sm text-center tabular-nums font-semibold" />
                    </div>
                  ))}
                </div>

                {bad && (
                  <p className="text-[10px] text-red-400">
                    Under 100% — you lose money on this fixture whatever the result. Shorten the odds.
                  </p>
                )}
              </div>
            );
          })}

          <p className="text-[10px] text-muted-foreground px-1 leading-relaxed">
            Margin is the three prices added up. <span className="text-emerald-400">100–115%</span> is healthy,
            <span className="text-red-400"> under 100%</span> loses money whatever happens, and
            <span className="text-amber-400"> over 115%</span> is steep enough that players will notice.
          </p>
        </div>

        {/* What it actually pays */}
        {example && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              What this card pays — max stake {ngn(num(editing.config.max_stake_tngn))}
            </p>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">All five favourites land</span>
              <span className="tabular-nums font-semibold">{ngn(example.favMax)}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">All five longshots land</span>
              <span className="tabular-nums font-semibold text-amber-300">{ngn(example.longMax)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1">
              Worst case for the house is the longshot row. Your per-card ceiling is{' '}
              {ngn(num(editing.config.card_liability_cap_tngn))} — the card stops selling there.
            </p>
          </div>
        )}

        {/* Advanced */}
        <div>
          <button onClick={() => set({ showAdvanced: !editing.showAdvanced })}
                  className="text-[11px] text-muted-foreground hover:text-foreground">
            {editing.showAdvanced ? '− Hide' : '+ Show'} pricing controls
          </button>
          {editing.showAdvanced && (
            <div className="grid grid-cols-2 gap-2 mt-2">
              {CONFIG_FIELDS.map(f => (
                <div key={f.key}>
                  <p className="text-[10px] text-muted-foreground mb-1">{f.label}</p>
                  <Input value={editing.config[f.key] ?? ''} inputMode="decimal"
                         onChange={e => set({ config: { ...editing.config, [f.key]: e.target.value } })}
                         className="h-8 text-xs tabular-nums" />
                  {f.hint && <p className="text-[9px] text-muted-foreground/70 mt-0.5">{f.hint}</p>}
                </div>
              ))}
              <button className="col-span-2 text-[11px] text-emerald-400 hover:text-emerald-300 text-left"
                      onClick={() => set({ config: { ...(presets[editing.kind] || {}) } })}>
                Reset to {editing.kind.replace('_', ' ')} preset
              </button>
            </div>
          )}
        </div>

        <Button size="sm" className="w-full bg-emerald-600 hover:bg-emerald-500"
                disabled={!!busy} onClick={save}>
          {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save draft'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── One run in the list ───────────────────────────────────────────────────
function RunRow({ run, busy, call, reload, setEditing }: any) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const pct = run.card_liability_cap_tngn > 0
    ? Math.min(100, (run.stats.liability / run.card_liability_cap_tngn) * 100) : 0;

  const act = async (body: any, label: string, ok: string) => {
    const d = await call({ ...body, id: run.id }, label);
    if (d) { toast({ title: ok }); reload(); }
    return d;
  };

  return (
    <Card className={run.status === 'live' ? 'border-emerald-500/30' : undefined}>
      <CardContent className="p-4 space-y-3">
        <button className="w-full text-left" onClick={() => setOpen(!open)}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium">{run.title}</p>
            <div className="flex gap-1 shrink-0">
              <Badge variant="outline" className="text-[9px] uppercase">{run.kind.replace('_', ' ')}</Badge>
              <Badge variant="outline" className="text-[9px] uppercase">{run.status}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground mt-1">
            <span>{run.stats.entries} entries</span>
            <span>{ngn(run.stats.staked)} staked</span>
            <span>{run.legs.filter((l: Leg) => l.result).length}/5 graded</span>
          </div>
          {run.stats.liability > 0 && (
            <div className="mt-2">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                <span>Exposure</span>
                <span className="tabular-nums">{ngn(run.stats.liability)} / {ngn(run.card_liability_cap_tngn)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                     style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </button>

        {open && (
          <div className="space-y-3 pt-2 border-t border-border">
            {/* grade each leg */}
            <div className="space-y-1.5">
              {run.legs.map((l: Leg) => (
                <div key={l.leg_index} className="flex items-center gap-2">
                  <span className="text-[11px] flex-1 truncate">{l.fixture}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {Number(l.odds_w).toFixed(2)}/{Number(l.odds_d).toFixed(2)}/{Number(l.odds_l).toFixed(2)}
                  </span>
                  {l.result ? (
                    <Badge className="text-[9px] bg-emerald-600 shrink-0">{l.result}</Badge>
                  ) : run.status === 'open' || run.status === 'live' ? (
                    <div className="flex gap-1 shrink-0">
                      {(['W', 'D', 'L'] as const).map(res => (
                        <button key={res} disabled={!!busy}
                                onClick={() => act({ action: 'resolve_leg', legIndex: l.leg_index, result: res },
                                                   `g${l.leg_index}${res}`, `Graded ${res}`)}
                                className="w-7 h-6 rounded border border-border text-[10px] font-semibold hover:bg-emerald-500/15">
                          {res}
                        </button>
                      ))}
                    </div>
                  ) : <span className="text-[10px] text-muted-foreground shrink-0">—</span>}
                </div>
              ))}
            </div>

            {preview && (
              <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.05] p-2.5 text-[11px]">
                <p className="font-medium text-emerald-300">Preview — nothing has moved</p>
                {preview.entries !== undefined && <p>{preview.entries} entries, {preview.winners} winners</p>}
                {preview.paidTngn !== undefined && <p>Would pay {ngn(preview.paidTngn)}</p>}
                {preview.refunded !== undefined && <p>Would refund {preview.refunded} entries, {ngn(preview.refundedTngn)}</p>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              {run.status === 'draft' && (
                <>
                  <Button size="sm" variant="outline" disabled={!!busy}
                          onClick={() => setEditing({
                            id: run.id, kind: run.kind, title: run.title,
                            closes_at: run.closes_at ? run.closes_at.slice(0, 16) : '',
                            legs: run.legs.length === 5 ? run.legs : [0,1,2,3,4].map(() => ({ ...BLANK_LEG })),
                            config: Object.fromEntries(CONFIG_FIELDS.map(f => [f.key, (run as any)[f.key]])),
                            showAdvanced: false,
                          })}>Edit</Button>
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500" disabled={!!busy}
                          onClick={() => act({ action: 'publish' }, 'pub', 'Published — now taking entries')}>
                    Publish
                  </Button>
                  <Button size="sm" variant="outline" className="col-span-2 text-red-400 border-red-500/30"
                          disabled={!!busy}
                          onClick={() => act({ action: 'delete_draft' }, 'del', 'Draft deleted')}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete draft
                  </Button>
                </>
              )}
              {run.status === 'open' && (
                <Button size="sm" variant="outline" className="col-span-2" disabled={!!busy}
                        onClick={() => act({ action: 'unpublish' }, 'unpub', 'Back to draft')}>
                  Unpublish (only if nobody has staked)
                </Button>
              )}
              {(run.status === 'open' || run.status === 'live') && (
                <>
                  <Button size="sm" variant="outline" disabled={!!busy}
                          onClick={async () => { const d = await act({ action: 'settle', dryRun: true }, 'sp', 'Previewed'); if (d) setPreview(d); }}>
                    Preview settle
                  </Button>
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500" disabled={!!busy || !preview}
                          onClick={async () => { await act({ action: 'settle', dryRun: false }, 'sa', 'Settled'); setPreview(null); }}>
                    Settle &amp; pay
                  </Button>
                  <Button size="sm" variant="outline" className="col-span-2 text-amber-400 border-amber-500/30"
                          disabled={!!busy}
                          onClick={async () => { const d = await act({ action: 'void', dryRun: true }, 'vp', 'Previewed void'); if (d) setPreview(d); }}>
                    Preview void (refund everyone)
                  </Button>
                  {preview?.refunded !== undefined && (
                    <Button size="sm" className="col-span-2 bg-amber-600 hover:bg-amber-500" disabled={!!busy}
                            onClick={async () => { await act({ action: 'void', dryRun: false }, 'va', 'Voided'); setPreview(null); }}>
                      Confirm void
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
