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
