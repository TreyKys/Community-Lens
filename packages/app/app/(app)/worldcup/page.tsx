import { createClient } from '@supabase/supabase-js';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'World Cup — powered by TxLINE',
  description:
    'Live World Cup prediction markets on Opinions NG, priced by the TxODDS feed and settled with Solana-anchored cryptographic proofs.',
};

type ProofRecord = {
  p1Goals: number;
  p2Goals: number;
  proposedOutcome: number;
  verified: boolean | null;
} | null;

type WcMarket = {
  id: number;
  question: string;
  options: string[];
  home_team: string | null;
  away_team: string | null;
  status: string;
  closes_at: string;
  resolved_outcome: number | null;
  resolution_source: string | null;
  txline_proof: ProofRecord;
};

function fmtKickoff(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function MatchRow({ m }: { m: WcMarket }) {
  const home = m.home_team || m.options?.[0] || 'Home';
  const away = m.away_team || m.options?.[2] || 'Away';
  const proof = m.txline_proof;
  const resolved = m.status === 'resolved';
  const winnerIdx = m.resolved_outcome ?? proof?.proposedOutcome;
  const winnerLabel = winnerIdx != null ? m.options?.[winnerIdx] : null;

  return (
    <Link href={`/event/${m.id}`} className="block">
      <Card className="hover:border-emerald-500/40 transition-colors">
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium truncate">
              {home} <span className="text-muted-foreground">v</span> {away}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{fmtKickoff(m.closes_at)}</div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {resolved && proof ? (
              <div className="text-right">
                <div className="tabular-nums font-semibold">
                  {proof.p1Goals}–{proof.p2Goals}
                </div>
                {winnerLabel && (
                  <div className="text-[11px] text-muted-foreground">
                    {m.resolution_source === 'admin_override' ? 'override: ' : ''}
                    {winnerLabel}
                  </div>
                )}
              </div>
            ) : m.status === 'locked' ? (
              <Badge variant="outline" className="text-amber-500 border-amber-500/40">awaiting result</Badge>
            ) : (
              <Badge variant="outline" className="text-emerald-500 border-emerald-500/40">open</Badge>
            )}
            {proof?.verified === true && <ShieldCheck className="w-4 h-4 text-emerald-500" />}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function WorldCupPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data } = await supabase
    .from('markets')
    .select(
      'id, question, options, home_team, away_team, status, closes_at, resolved_outcome, resolution_source, txline_proof'
    )
    .not('txline_competition_id', 'is', null)
    .order('closes_at', { ascending: true })
    .limit(200);

  const markets = (data as WcMarket[]) || [];
  const resolved = markets.filter((m) => m.status === 'resolved');
  const awaiting = markets.filter((m) => m.status === 'locked');
  const upcoming = markets.filter((m) => m.status === 'open');

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-8 pb-24">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">World Cup 2026</h1>
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
            powered by TxLINE
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Priced by the TxODDS consensus feed. Every result is settled against a Solana-anchored
          cryptographic proof — <ShieldCheck className="inline w-3.5 h-3.5 text-emerald-500" /> marks
          on-chain-verified outcomes.
        </p>
      </header>

      {markets.length === 0 && (
        <div className="text-center text-muted-foreground border rounded-xl p-10">
          No World Cup markets yet. Run <code className="text-xs">/api/txline/sync-fixtures</code> to import fixtures.
        </div>
      )}

      {awaiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Awaiting settlement</h2>
          {awaiting.map((m) => <MatchRow key={m.id} m={m} />)}
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Upcoming</h2>
          {upcoming.map((m) => <MatchRow key={m.id} m={m} />)}
        </section>
      )}

      {resolved.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settled</h2>
          {resolved.map((m) => <MatchRow key={m.id} m={m} />)}
        </section>
      )}
    </div>
  );
}
