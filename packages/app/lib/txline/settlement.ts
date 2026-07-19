// TxLINE settlement — derive a Match Winner outcome from the signed feed and
// attach the verifiable proof to the market as a *proposal*. No payouts happen
// here; the admin approves or overrides, then the existing resolve route runs.
//
// Winner is read off the action=game_finalised record's Stats:
//   Stats['1'] = Participant 1 total goals, Stats['2'] = Participant 2 total.
// A regulation/ET draw that went to penalties is broken by Stats['6001'/'6002']
// (penalty-shootout goals). Market options are [P1, 'Draw', P2] -> index 0/1/2.

import { getSupabaseAdmin } from '@/lib/oracle';
import {
  scoresHistorical,
  scoresSnapshot,
  statValidation,
  rd,
  type StatValidationProof,
} from './client';
import { txlineConfig, STAT_KEY, GAME_FINALISED_ACTION } from './config';
import { verifyOutcomeOnChain } from './verify';

export type FinalOutcome = {
  p1Goals: number;
  p2Goals: number;
  p1Pens: number;
  p2Pens: number;
  wentToPens: boolean;
  proposedOutcome: number; // 0 = P1 win, 1 = Draw, 2 = P2 win
  seq: number;
  ts: number;
};

function statNum(stats: any, key: number): number {
  if (!stats) return 0;
  const v = stats[String(key)] ?? stats[key];
  return typeof v === 'number' ? v : Number(v) || 0;
}

/** True for an action=game_finalised record (final outcome, any end state). */
export function isFinalRecord(record: any): boolean {
  return rd.action(record) === GAME_FINALISED_ACTION;
}

/** The latest game_finalised record in a set (by seq), or null. */
export function findFinalRecord(records: any[]): any | null {
  const finals = (records || []).filter(isFinalRecord);
  if (finals.length === 0) return null;
  return finals.reduce((best, r) => ((rd.seq(r) ?? 0) > (rd.seq(best) ?? 0) ? r : best));
}

/** Derive the 1X2 outcome from a game_finalised record's Stats. */
export function readOutcome(record: any): FinalOutcome {
  const stats = record?.Stats ?? record?.stats;
  const p1Goals = statNum(stats, STAT_KEY.P1_GOALS);
  const p2Goals = statNum(stats, STAT_KEY.P2_GOALS);
  const p1Pens = statNum(stats, STAT_KEY.P1_PEN_GOALS);
  const p2Pens = statNum(stats, STAT_KEY.P2_PEN_GOALS);
  const wentToPens = p1Pens > 0 || p2Pens > 0;

  let proposedOutcome: number;
  if (p1Goals > p2Goals) proposedOutcome = 0;
  else if (p2Goals > p1Goals) proposedOutcome = 2;
  else if (wentToPens) proposedOutcome = p1Pens > p2Pens ? 0 : 2;
  else proposedOutcome = 1; // genuine draw (group stage)

  return {
    p1Goals, p2Goals, p1Pens, p2Pens, wentToPens, proposedOutcome,
    seq: rd.seq(record) ?? 0,
    ts: rd.ts(record) ?? 0,
  };
}

export type TxlineProofRecord = {
  fixtureId: number;
  seq: number;
  statKeys: number[];
  p1Goals: number;
  p2Goals: number;
  wentToPens: boolean;
  proposedOutcome: number;
  network: string;
  programId: string;
  // epochDay + minTimestamp let a verifier re-derive the daily_scores_roots PDA.
  epochDay: number | null;
  minTimestamp: number | null;
  // On-chain validateStatV2 result: true/false when checked, null when the
  // on-chain step was skipped (deps/RPC unavailable). The signed proof below
  // is stored regardless — it is the on-chain-anchored evidence.
  verified: boolean | null;
  proof: StatValidationProof | null;
  fetchedAt: number;
};

/**
 * Build the proof record for a decided fixture. Fetches the stat-validation
 * Merkle proof for statKeys [1,2]; never throws on proof failure (returns a
 * record with proof=null so the human still sees the derived outcome).
 */
export async function buildProof(fixtureId: number, outcome: FinalOutcome): Promise<TxlineProofRecord> {
  const statKeys = [STAT_KEY.P1_GOALS, STAT_KEY.P2_GOALS];
  let proof: StatValidationProof | null = null;
  let epochDay: number | null = null;
  let minTimestamp: number | null = null;

  let verified: boolean | null = null;
  try {
    proof = await statValidation(fixtureId, outcome.seq, statKeys);
    minTimestamp = proof?.summary?.updateStats?.minTimestamp ?? null;
    if (minTimestamp != null) epochDay = Math.floor(minTimestamp / 86_400_000);
    // Best-effort on-chain re-verification (no-op unless TXLINE_ONCHAIN_VERIFY).
    if (proof) verified = await verifyOutcomeOnChain(proof, outcome.proposedOutcome);
  } catch (err) {
    console.warn(`[txline] proof fetch failed for fixture ${fixtureId} seq ${outcome.seq}:`, err);
  }

  return {
    fixtureId,
    seq: outcome.seq,
    statKeys,
    p1Goals: outcome.p1Goals,
    p2Goals: outcome.p2Goals,
    wentToPens: outcome.wentToPens,
    proposedOutcome: outcome.proposedOutcome,
    network: txlineConfig.network,
    programId: txlineConfig.programId,
    epochDay,
    minTimestamp,
    verified,
    proof,
    fetchedAt: Date.now(),
  };
}

export type ProposalResult =
  | { status: 'proposed'; marketId: number; outcome: FinalOutcome; proof: TxlineProofRecord }
  | { status: 'not_final'; marketId: number; reason: string }
  | { status: 'error'; marketId: number; reason: string };

/**
 * Look for a finished result for a mapped market and, if found, stage the
 * proposal: store txline_proof and move the market to 'locked' (no more bets,
 * ready for admin approve/override). Idempotent — re-running just refreshes
 * the proof; it never resolves or pays out.
 */
export async function proposeResolutionForMarket(market: {
  id: number;
  txline_fixture_id: number | null;
  status: string;
}): Promise<ProposalResult> {
  const fixtureId = market.txline_fixture_id;
  if (!fixtureId) return { status: 'error', marketId: market.id, reason: 'no txline_fixture_id' };

  try {
    // Historical carries the full ordered sequence for a started fixture;
    // fall back to the live snapshot if the historical window has passed.
    let records: any[] = [];
    try {
      records = await scoresHistorical(fixtureId);
    } catch {
      records = await scoresSnapshot(fixtureId);
    }

    const finalRecord = findFinalRecord(records);
    if (!finalRecord) {
      return { status: 'not_final', marketId: market.id, reason: 'no game_finalised record yet' };
    }

    const outcome = readOutcome(finalRecord);
    const proof = await buildProof(fixtureId, outcome);

    const supabaseAdmin = getSupabaseAdmin();
    const patch: Record<string, unknown> = { txline_proof: proof };
    // Lock the market so betting stops while it awaits admin approval. Don't
    // touch already-resolved/void markets.
    if (market.status === 'open') patch.status = 'locked';

    const { error } = await supabaseAdmin.from('markets').update(patch).eq('id', market.id);
    if (error) return { status: 'error', marketId: market.id, reason: error.message };

    return { status: 'proposed', marketId: market.id, outcome, proof };
  } catch (err: any) {
    return { status: 'error', marketId: market.id, reason: err?.message || String(err) };
  }
}
