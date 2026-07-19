import { createClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, ShieldAlert, ExternalLink } from 'lucide-react';

// Public, verifiable settlement receipt for a TxLINE-mapped market.
//
// Renders nothing unless the market carries a txline_proof. It surfaces the
// signed result, the Solana anchor, and — per the governance rule — flags any
// admin override transparently, side-by-side with the feed's own proposal.

type ProofRecord = {
  fixtureId: number;
  seq: number;
  statKeys: number[];
  p1Goals: number;
  p2Goals: number;
  wentToPens: boolean;
  proposedOutcome: number;
  network: string;
  programId: string;
  epochDay: number | null;
  verified: boolean | null;
};

type MarketRow = {
  id: number;
  options: string[];
  home_team: string | null;
  away_team: string | null;
  status: string;
  resolved_outcome: number | null;
  resolution_source: string | null;
  override_reason: string | null;
  txline_fixture_id: number | null;
  txline_proof: ProofRecord | null;
};

function solscanAccount(address: string, network: string): string {
  const cluster = network === 'mainnet' ? '' : `?cluster=${network}`;
  return `https://solscan.io/account/${address}${cluster}`;
}

export default async function TxlineProofPanel({ marketId }: { marketId: number }) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data } = await supabase
    .from('markets')
    .select(
      'id, options, home_team, away_team, status, resolved_outcome, resolution_source, override_reason, txline_fixture_id, txline_proof'
    )
    .eq('id', marketId)
    .maybeSingle();

  const market = data as MarketRow | null;
  const proof = market?.txline_proof;
  if (!market || !proof) return null;

  const home = market.home_team || market.options?.[0] || 'Home';
  const away = market.away_team || market.options?.[2] || 'Away';
  const options = Array.isArray(market.options) ? market.options : [];

  const finalIndex = market.resolved_outcome ?? proof.proposedOutcome;
  const finalLabel = options[finalIndex] ?? `Outcome ${finalIndex}`;
  const feedLabel = options[proof.proposedOutcome] ?? `Outcome ${proof.proposedOutcome}`;
  const isOverride = market.resolution_source === 'admin_override';
  const isResolved = market.status === 'resolved';

  const verified = proof.verified === true;

  return (
    <Card className="border-emerald-500/30 bg-emerald-500/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {verified ? (
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-emerald-500/70" />
            )}
            Settlement Proof
          </CardTitle>
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
            TxLINE · {proof.network}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {/* Signed scoreline */}
        <div className="rounded-lg border bg-background/50 p-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Signed result
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {home} <span className="text-emerald-500">{proof.p1Goals}</span>
            <span className="text-muted-foreground mx-1">–</span>
            <span className="text-emerald-500">{proof.p2Goals}</span> {away}
          </div>
          {proof.wentToPens && (
            <div className="text-xs text-muted-foreground mt-1">Decided on penalties</div>
          )}
        </div>

        {/* Provenance — the governance surface */}
        {isOverride ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] p-3 space-y-1">
            <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
              <ShieldAlert className="w-4 h-4" /> Admin override
            </div>
            <div className="text-muted-foreground">
              The signed feed proposed <span className="font-medium text-foreground">{feedLabel}</span>.
              This market was resolved as <span className="font-medium text-foreground">{finalLabel}</span>.
            </div>
            {market.override_reason && (
              <div className="text-muted-foreground">
                Reason: <span className="text-foreground">{market.override_reason}</span>
              </div>
            )}
          </div>
        ) : (
          isResolved && (
            <div className="text-muted-foreground">
              Resolved as <span className="font-medium text-foreground">{finalLabel}</span>, exactly as
              the signed feed proposed. No human changed the outcome.
            </div>
          )
        )}

        {/* On-chain anchor */}
        <div className="rounded-lg border bg-background/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {verified ? (
              <Badge className="bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">
                ✓ Verified on-chain
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Signed Merkle proof stored
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {verified
                ? 'validateStatV2 passed against the on-chain daily score roots'
                : 'Anchored to TxLINE’s on-chain daily score roots'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Fixture <span className="text-foreground tabular-nums">{proof.fixtureId}</span> · seq{' '}
              <span className="text-foreground tabular-nums">{proof.seq}</span> · stats{' '}
              <span className="text-foreground tabular-nums">[{proof.statKeys.join(', ')}]</span>
            </div>
            <a
              href={solscanAccount(proof.programId, proof.network)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline break-all"
            >
              Program {proof.programId.slice(0, 8)}…{proof.programId.slice(-6)}
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Result data is cryptographically signed by TxODDS and anchored on Solana. The signed feed is
          our default source of truth; any admin departure from it is recorded and shown above.
        </p>
      </CardContent>
    </Card>
  );
}
