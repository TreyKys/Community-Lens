// Per-outcome sentiment as a percentage of the EFFECTIVE pool (seed +
// active real bets). Shared by every surface that needs to say "X% of
// predictors picked this" — the picks API, the OPx Picks share-card
// image, and its pre-bet preview twin — so they all read the same
// number the bet modal's chart does. Returns null on lookup failure;
// callers should just omit the line rather than show a fake 0%.
export async function getSentimentPct(
  supa: any,
  marketId: number | string,
  outcomeIndex: number,
  optionCount: number,
  seedPoolMap: Record<string, number> | null | undefined,
): Promise<number | null> {
  try {
    const { data: bets } = await supa
      .from('user_bets')
      .select('outcome_index, net_stake_tngn')
      .eq('market_id', marketId)
      .eq('status', 'active');

    const totals: number[] = Array.from({ length: optionCount }, () => 0);
    for (const b of bets || []) {
      const i = Number((b as any).outcome_index);
      if (i >= 0 && i < optionCount) {
        totals[i] += Number((b as any).net_stake_tngn || 0);
      }
    }
    const effective: number[] = totals.map((real, i) => {
      const seed = Number((seedPoolMap || {})[String(i)] ?? 0);
      const safeSeed = Number.isFinite(seed) && seed > 0 ? seed : 0;
      return safeSeed + real;
    });
    const sum = effective.reduce((s, v) => s + v, 0);
    if (sum <= 0) return null;
    const idx = outcomeIndex;
    if (idx < 0 || idx >= optionCount) return null;
    return Math.round((effective[idx] / sum) * 100);
  } catch {
    return null;
  }
}
