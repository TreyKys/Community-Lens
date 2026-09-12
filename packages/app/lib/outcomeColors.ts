// Categorical colors for "one color per outcome" visuals — the probability
// bar + legend on a Trade market, and the "where the money's leaning" preview
// on a locked-odds market card. One palette, reused everywhere a market's
// outcomes need to be told apart at a glance, so the two staking modes read
// as one visual language rather than two products that happen to share a nav.
//
// These are NOT arbitrary Tailwind picks. They're the dataviz skill's
// reference categorical palette (references/palette.md), dark-mode column,
// re-validated against this app's actual card surface (#111a16, the
// --card token in globals.css) rather than the skill's generic default:
//
//   node scripts/validate_palette.js "<8 hex>" --mode dark --surface "#111a16"
//   → ALL CHECKS PASS on the adjacent pairlist (the one that applies here —
//     a segmented bar and a stacked legend are "bars", not a scatter/bubble
//     chart, so adjacent-pair separation is what actually gets seen).
//
// Fixed hue order, never cycled or reassigned by rank: color follows the
// OUTCOME (its index in the market's outcome array, set once at creation),
// never its current price. If price changed which color looked "biggest",
// a leader trading places with the runner-up would repaint everyone's
// held color, which is the one thing a legend must never do.
export const OUTCOME_COLORS = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767', // 8 red
] as const;

// Past 8 outcomes (BBN eviction casts routinely run to 20-30), no ordering of
// hand-picked hues clears the CVD floors at once — the dataviz skill's own
// non-negotiable is that a 9th series is never a generated hue, it folds into
// "Other". So it does: everything from index 8 on shares one muted tone,
// distinguished by its label and price in the legend instead of a color.
export const OUTCOME_OTHER_COLOR = '#6b7280'; // slate-500 — reads as "the rest", not a 9th hue

export function outcomeColor(index: number): string {
  return OUTCOME_COLORS[index] ?? OUTCOME_OTHER_COLOR;
}

// ── Binary polarity ────────────────────────────────────────────────────────
// A two-sided Yes/No question is the one case where color can carry MEANING
// rather than just identity, and every prediction market on earth spends that
// affordance the same way: green for the yes side, red for the no side. Our
// own bet buttons have always done this too — getOptionStyle() in
// MarketList.tsx has tinted yes/home/win blue-ish and no/away/lose red-ish
// since long before any of this. What was missing was the BAR agreeing with
// the buttons sitting under it.
//
// Deliberately narrow: this only fires when a market has exactly two outcomes
// AND they are literally a recognised polar pair. "Real Madrid" vs "Rayo
// Vallecano" is a two-outcome market where red/green would be inventing a
// good guy and a bad guy, so it keeps the categorical palette above, as does
// every 3+ outcome market. Nothing loses its colors here; one specific shape
// gains a meaning.
//
// Both hexes validated together against the app's card surface (#111a16):
//   node scripts/validate_palette.js "#059669,#ef4444" --mode dark --surface "#111a16" --pairs all
//   → ALL CHECKS PASS (CVD ΔE 9.6 deutan, normal-vision 31.7, both >= 3:1)
// Red/green is the classic confusable pair, so the rule everywhere this is
// used: the side's LABEL is always printed next to its color, never color
// alone. That is the secondary encoding the separation numbers assume.
export const YES_COLOR = '#059669';   // emerald-600 — our own green, one step down
export const NO_COLOR  = '#ef4444';   // red-500 — already the app's "against" red

const YES_TOKENS = new Set(['yes', 'over', 'above', 'true', 'higher', 'up']);
const NO_TOKENS  = new Set(['no', 'under', 'below', 'false', 'lower', 'down']);

const token = (s: string) => s.trim().toLowerCase().replace(/[.!?]+$/, '');

/**
 * For a recognised two-sided market, which index is the "yes" pole.
 * Returns null for anything else — including 2-outcome markets that are just
 * two names (a fixture, two candidates), which keep the categorical palette.
 */
export function binaryYesIndex(outcomes: string[]): number | null {
  if (outcomes?.length !== 2) return null;
  const [a, b] = outcomes.map(token);
  if (YES_TOKENS.has(a) && NO_TOKENS.has(b)) return 0;
  if (YES_TOKENS.has(b) && NO_TOKENS.has(a)) return 1;
  return null;
}

/**
 * The one entry point every outcome visual should use: hand it the outcome
 * labels, get back a color per outcome. Yes/No books come back green/red;
 * everything else comes back in the categorical palette, unchanged.
 */
export function outcomeColorsFor(outcomes: string[]): string[] {
  const yesIdx = binaryYesIndex(outcomes);
  if (yesIdx !== null) {
    return outcomes.map((_, i) => (i === yesIdx ? YES_COLOR : NO_COLOR));
  }
  return outcomes.map((_, i) => outcomeColor(i));
}
