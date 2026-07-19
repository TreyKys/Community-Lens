'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';

type ProofRecord = {
  fixtureId: number;
  seq: number;
  p1Goals: number;
  p2Goals: number;
  wentToPens: boolean;
  proposedOutcome: number;
  network: string;
  verified: boolean | null;
};

type Proposal = {
  id: number;
  question: string;
  options: string[];
  home_team: string | null;
  away_team: string | null;
  status: string;
  txline_proof: ProofRecord;
};

export default function AdminTxlinePage() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [secret, setSecret] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [rows, setRows] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Per-market override drafts: { [marketId]: { index, reason } }
  const [override, setOverride] = useState<Record<number, { index: number | null; reason: string }>>({});

  useEffect(() => {
    fetch('/api/admin/auth')
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false))
      .finally(() => setChecking(false));
  }, []);

  const login = async () => {
    setLoggingIn(true);
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (res.ok) setIsAdmin(true);
      else toast({ title: 'Invalid secret', variant: 'destructive' });
    } finally {
      setLoggingIn(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('markets')
      .select('id, question, options, home_team, away_team, status, txline_proof')
      .not('txline_proof', 'is', null)
      .eq('status', 'locked')
      .order('closes_at', { ascending: true });
    if (error) toast({ title: 'Load failed', description: error.message, variant: 'destructive' });
    setRows((data as Proposal[]) || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const resolve = async (
    m: Proposal,
    source: 'feed' | 'admin_override',
    winningOutcomeIndex?: number,
    overrideReason?: string
  ) => {
    setBusyId(m.id);
    try {
      const res = await fetch('/api/txline/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ marketId: m.id, source, winningOutcomeIndex, overrideReason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: 'Resolve failed', description: body?.error || `HTTP ${res.status}`, variant: 'destructive' });
        return;
      }
      toast({ title: source === 'feed' ? 'Approved feed result' : 'Override applied', description: `Market ${m.id} resolved.` });
      setRows((prev) => prev.filter((r) => r.id !== m.id));
    } finally {
      setBusyId(null);
    }
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="max-w-sm mx-auto mt-24 px-4">
        <Card>
          <CardHeader><CardTitle>Admin access</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="password"
              placeholder="Admin secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && secret && login()}
            />
            <Button className="w-full" onClick={login} disabled={loggingIn || !secret}>
              {loggingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Unlock'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">TxLINE settlement queue</h1>
          <p className="text-sm text-muted-foreground">
            The signed feed proposes; you approve it, or override with a reason. Overrides are recorded and shown publicly.
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {rows.length === 0 && !loading && (
        <div className="text-center text-muted-foreground border rounded-xl p-10">
          No proposals awaiting approval. Run <code className="text-xs">/api/txline/propose</code> after a fixture finishes.
        </div>
      )}

      {rows.map((m) => {
        const p = m.txline_proof;
        const home = m.home_team || m.options?.[0] || 'Home';
        const away = m.away_team || m.options?.[2] || 'Away';
        const proposedLabel = m.options?.[p.proposedOutcome] ?? `Outcome ${p.proposedOutcome}`;
        const draft = override[m.id];
        const busy = busyId === m.id;

        return (
          <Card key={m.id} className="overflow-hidden">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-base leading-snug">{m.question}</CardTitle>
                <Badge variant="outline" className="shrink-0 border-emerald-500/40 text-emerald-500">
                  TxLINE · {p.network}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-lg font-semibold tabular-nums">
                  {home} {p.p1Goals}–{p.p2Goals} {away}
                </span>
                {p.wentToPens && <span className="text-xs text-muted-foreground">(penalties)</span>}
                {p.verified === true ? (
                  <Badge className="bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">
                    <ShieldCheck className="w-3 h-3 mr-1" /> verified on-chain
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">signed proof stored</Badge>
                )}
              </div>

              <div className="rounded-lg border bg-muted/30 p-3">
                Feed proposes: <span className="font-semibold text-foreground">{proposedLabel}</span>
                <span className="text-xs text-muted-foreground ml-2">fixture {p.fixtureId} · seq {p.seq}</span>
              </div>

              {/* Primary action: accept the feed */}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => resolve(m, 'feed')} disabled={busy}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <ShieldCheck className="w-4 h-4 mr-1" />}
                  Approve feed result
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    setOverride((o) => ({ ...o, [m.id]: draft ? { ...draft } : { index: null, reason: '' } }))
                  }
                  disabled={busy}
                >
                  <ShieldAlert className="w-4 h-4 mr-1" /> Override…
                </Button>
              </div>

              {/* Override drawer */}
              {draft && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.05] p-3 space-y-3">
                  <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    Override the signed feed — choose the outcome and give a reason (both required).
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {m.options.map((opt, i) => (
                      <Button
                        key={i}
                        size="sm"
                        variant={draft.index === i ? 'default' : 'outline'}
                        disabled={i === p.proposedOutcome}
                        title={i === p.proposedOutcome ? 'This is the feed proposal — approve it instead' : ''}
                        onClick={() => setOverride((o) => ({ ...o, [m.id]: { ...draft, index: i } }))}
                      >
                        {opt}
                      </Button>
                    ))}
                  </div>
                  <Textarea
                    placeholder="Why are you overriding the signed feed? (e.g. match abandoned at 78', official replay ordered)"
                    value={draft.reason}
                    onChange={(e) => setOverride((o) => ({ ...o, [m.id]: { ...draft, reason: e.target.value } }))}
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy || draft.index === null || !draft.reason.trim()}
                      onClick={() => resolve(m, 'admin_override', draft.index ?? undefined, draft.reason.trim())}
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                      Confirm override
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOverride((o) => { const n = { ...o }; delete n[m.id]; return n; })}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
