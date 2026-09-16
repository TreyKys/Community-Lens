import { calculateLockedOdds } from '@/lib/lockedOdds';

// Shared by every admin surface that seeds a locked-odds market — the
// plain Create form and the legacy-market "migrate to locked-odds"
// conversion — so the seed-pool math and the odds preview can never
// quietly disagree between them. One function builds the pool, one prices
// it; every caller uses both rather than keeping its own copy.

// Three stakes, not one. A single "₦500 sample" was the only number an
// admin ever saw before hitting Create, and it doesn't cover the engine
// that carries most of this platform's actual volume — a Multiplier leg
// prices off a FIXED ₦100 reference stake, never the real stake size (see
// place_multiplier_slip's c_leg_pricing_reference_stake). A market that
// looked fine at ₦500 could still be exactly what surprised an admin the
// day real Multiplier legs, all priced at ₦100, all landed on the same
// frozen number. ₦500 is also the Tier 1→2 boundary, and ₦2,000 is a
// plausible larger single stake — together these cover what an admin
// actually needs to see before confirming.
export const ODDS_PREVIEW_STAKES: { stake: number; label: string }[] = [
  { stake: 100, label: 'Multiplier leg' },
  { stake: 500, label: 'Tier 1→2 boundary' },
  { stake: 2000, label: 'Larger single stake' },
];

/**
 * Compose the opening seed pool from an admin's raw form inputs — the
 * same shape the API derives server-side, computed client-side so a
 * preview never needs a round trip. Self-contained: does its own minimal
 * validity checks rather than depending on a page-specific validator, so
 * it can be called from any admin surface.
 */
export function buildLockedOddsSeedPool(input: {
  seedSize: string;
  seedProbability: string;
  seedProbsMulti: string[];
  numOutcomes: number;
}): number[] {
  const seedSizeNum = Number(input.seedSize);
  const validSeed = Number.isFinite(seedSizeNum) && seedSizeNum >= 1_000 && seedSizeNum <= 14_000;
  if (!validSeed || input.numOutcomes < 2) return [];

  if (input.numOutcomes === 2) {
    const seedProbNum = Number(input.seedProbability);
    const validProb = Number.isFinite(seedProbNum) && seedProbNum >= 0.05 && seedProbNum <= 0.95;
    if (!validProb) return [];
    const yes = Math.round(seedSizeNum * seedProbNum);
    return [yes, seedSizeNum - yes];
  }

  const multiProbs = input.seedProbsMulti.slice(0, input.numOutcomes).map(s => Number(s));
  const multiProbSum = multiProbs.reduce((a, p) => a + (Number.isFinite(p) ? p : 0), 0);
  const validMultiProbs =
    multiProbs.length === input.numOutcomes
    && multiProbs.every(p => Number.isFinite(p) && p >= 0.02 && p <= 0.98)
    && Math.abs(multiProbSum - 1) <= 0.005;

  if (validMultiProbs) {
    const raw = multiProbs.map(p => Math.round(seedSizeNum * p));
    // Crumb-correct so the sum equals seedSize exactly.
    const drift = seedSizeNum - raw.reduce((a, v) => a + v, 0);
    raw[0] += drift;
    return raw;
  }
  // Fallback while the admin is mid-edit (inputs don't sum to 1 yet):
  // render a uniform-split preview so the panel stays informative rather
  // than blank.
  const share = Math.round(seedSizeNum / input.numOutcomes);
  const out = Array.from({ length: input.numOutcomes }, () => share);
  out[0] = seedSizeNum - share * (input.numOutcomes - 1);
  return out;
}

export type OddsPreviewRow = {
  stake: number;
  label: string;
  perOutcome: (ReturnType<typeof calculateLockedOdds> | null)[];
};

export function buildOddsPreviewTable(input: {
  seedPool: number[];
  category: string;
  vigOverride: string;
  reserveDeployable: number | null;
}): OddsPreviewRow[] | null {
  if (input.seedPool.length < 2) return null;
  const vigNum = input.vigOverride.trim() === '' ? undefined : Number(input.vigOverride);
  return ODDS_PREVIEW_STAKES.map(({ stake, label }) => ({
    stake,
    label,
    perOutcome: input.seedPool.map((_, i) => {
      try {
        return calculateLockedOdds(
          { category: input.category, seedPool: input.seedPool, realPool: Array(input.seedPool.length).fill(0), vigPctOverride: vigNum },
          stake, i, {}, { deployableTngn: input.reserveDeployable ?? 120_000, floorTngn: 30_000 },
        );
      } catch {
        return null;
      }
    }),
  }));
}
