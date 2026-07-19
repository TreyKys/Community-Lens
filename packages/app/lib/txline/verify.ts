// On-chain re-verification of a TxLINE result via validateStatV2 (read-only).
//
// This is the "gold" layer: it proves the proposed Match Winner outcome against
// TxLINE's on-chain daily score roots using a read-only .view() simulation — no
// transaction, no SOL. Ported from documentation/examples/onchain-validation.mdx
// and the proven subscription_scores flow ("On-chain stat validation passed").
//
// Everything is best-effort and lazily loaded: if @coral-xyz/anchor isn't
// available, the RPC is unreachable, or the predicate fails, the caller keeps
// the stored signed proof and simply reports verified=null. It never blocks a
// proposal. Gated by TXLINE_ONCHAIN_VERIFY to keep the default path dependency-
// light; flip it on once you've confirmed a run against your Solana RPC.

import { txlineConfig } from './config';
import type { StatValidationProof } from './client';

export function onchainVerifyEnabled(): boolean {
  return process.env.TXLINE_ONCHAIN_VERIFY === '1' || process.env.TXLINE_ONCHAIN_VERIFY === 'true';
}

function toBytes32(value: string | number[] | Uint8Array): number[] {
  const bytes = Array.isArray(value)
    ? Uint8Array.from(value)
    : value instanceof Uint8Array
      ? value
      : value.startsWith('0x')
        ? Buffer.from(value.slice(2), 'hex')
        : Buffer.from(value, 'base64');
  if (bytes.length !== 32) throw new Error(`Expected 32 bytes, received ${bytes.length}`);
  return Array.from(bytes);
}

function toProofNodes(nodes: Array<{ hash: string | number[] | Uint8Array; isRightSibling: boolean }>) {
  return nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));
}

// P1_goals - P2_goals comparison that must hold for a given 1X2 outcome.
function comparisonForOutcome(outcome: number): Record<string, Record<string, never>> {
  if (outcome === 0) return { greaterThan: {} }; // P1 win
  if (outcome === 2) return { lessThan: {} };     // P2 win
  return { equalTo: {} };                          // draw
}

/**
 * Run validateStatV2 for statKeys [1,2] with a binary (P1 - P2) predicate that
 * matches `proposedOutcome`. Returns true/false from the on-chain simulation,
 * or null if verification could not be performed. Never throws.
 */
export async function verifyOutcomeOnChain(
  proof: StatValidationProof,
  proposedOutcome: number
): Promise<boolean | null> {
  if (!onchainVerifyEnabled()) return null;

  try {
    // Lazy, guarded imports so a missing dep never breaks the build/runtime.
    const anchor = await import('@coral-xyz/anchor');
    const { Connection, PublicKey, ComputeBudgetProgram, Keypair } = await import('@solana/web3.js');
    const idl =
      txlineConfig.network === 'mainnet'
        ? (await import('./idl/txoracle.mainnet.json')).default
        : (await import('./idl/txoracle.devnet.json')).default;

    const { BN } = anchor;
    const connection = new Connection(txlineConfig.solanaRpcUrl, 'confirmed');
    const wallet = new anchor.Wallet(Keypair.generate()); // dummy — .view() never signs
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const program = new anchor.Program(idl as any, provider);

    const minTs = proof.summary.updateStats.minTimestamp;
    const epochDay = Math.floor(minTs / (24 * 60 * 60 * 1000));
    const [dailyScoresPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('daily_scores_roots'), new BN(epochDay).toArrayLike(Buffer, 'le', 2)],
      program.programId
    );

    const payload = {
      ts: new BN(minTs),
      fixtureSummary: {
        fixtureId: new BN(proof.summary.fixtureId),
        updateStats: {
          updateCount: proof.summary.updateStats.updateCount,
          minTimestamp: new BN(proof.summary.updateStats.minTimestamp),
          maxTimestamp: new BN(proof.summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: toBytes32(proof.summary.eventStatsSubTreeRoot),
      },
      fixtureProof: toProofNodes(proof.subTreeProof),
      mainTreeProof: toProofNodes(proof.mainTreeProof),
      eventStatRoot: toBytes32(proof.eventStatRoot),
      stats: proof.statsToProve.map((stat: unknown, index: number) => ({
        stat,
        statProof: toProofNodes(proof.statProofs[index]),
      })),
    };

    // statKeys were requested as [1,2] -> index 0 = P1 goals, index 1 = P2 goals.
    const strategy = {
      geometricTargets: [],
      distancePredicate: null,
      discretePredicates: [
        {
          binary: {
            indexA: 0,
            indexB: 1,
            op: { subtract: {} },
            predicate: { threshold: 0, comparison: comparisonForOutcome(proposedOutcome) },
          },
        },
      ],
    };

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

    const isValid = await (program.methods as any)
      .validateStatV2(payload, strategy)
      .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
      .preInstructions([computeIx])
      .view();

    return Boolean(isValid);
  } catch (err) {
    console.warn('[txline] on-chain verify skipped:', (err as Error)?.message || err);
    return null;
  }
}
