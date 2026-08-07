// Deciding what text goes on an anticipation card.
//
// Extracted from the card route so it can be tested. The route renders
// pixels, which are awkward to assert against; these are the decisions
// that actually determine whether a card reads well.

/** Longest headline that still reads at poster size on a phone. */
const MAX_HEADLINE = 120;

/**
 * The line the card carries.
 *
 * A post can run to 240 characters. All of it at poster size is a wall
 * nobody reads, so the card takes the opening thought and lets the post
 * text underneath carry the rest — in the timeline they are seen
 * together.
 *
 * Ending on a COMPLETE sentence matters more than using the full space.
 * The naive version cut at the last word before the limit and appended
 * an ellipsis, which on a real draft produced:
 *
 *   "BBN is back. Get ready for 70 days of 'ships', gbas gbos, and
 *    daily agenda. The streets never rest when Biggie is…"
 *
 * — trailing off mid-clause while a clean break sat 40 characters
 * earlier. So: prefer the last sentence that ends within the limit, and
 * only fall back to a word-boundary ellipsis when there is no sentence
 * break to use.
 */
export function headlineFrom(body: string): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_HEADLINE) return clean;

  // Every sentence ending at or before the limit; take the last.
  let lastEnd = -1;
  for (let i = 0; i < Math.min(clean.length, MAX_HEADLINE); i++) {
    if (/[.!?]/.test(clean[i]) && (i + 1 >= clean.length || /\s/.test(clean[i + 1]))) {
      lastEnd = i;
    }
  }

  // Require enough text to be worth showing — a card reading just "BBN
  // is back." wastes the space even though it is a valid sentence.
  if (lastEnd >= 40) return clean.slice(0, lastEnd + 1);

  const cut = clean.slice(0, MAX_HEADLINE);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '') + '…';
}

/** The eyebrow above the headline — names the subject at a glance. */
export function kickerFrom(brief: string | null, kind: string): string {
  if (brief) {
    const words = brief.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (words.length) return words.join(' ').toUpperCase().slice(0, 24);
  }
  if (kind === 'evergreen') return 'HOW IT WORKS';
  if (kind === 'movement') return 'LINE MOVING';
  if (kind === 'settlement') return 'SETTLED';
  return 'OPINIONS';
}

/**
 * The forward-looking pill.
 *
 * "MARKET OPEN" only when a market actually backs the post. A briefed
 * post about Big Brother Naija may have no market at all, and a card
 * announcing one that does not exist is a false claim on a regulated
 * product's account — not merely an odd caption.
 */
export function pillFor(kind: string, hasMarket: boolean): string {
  if (hasMarket) return 'MARKET OPEN';
  if (kind === 'settlement') return 'SETTLED';
  if (kind === 'movement') return 'LINE MOVING';
  if (kind === 'evergreen') return 'HOW IT WORKS';
  return 'CALL IT';
}

/** Type size that keeps the headline inside the frame. */
export function headlineSize(len: number): number {
  return len > 100 ? 52 : len > 70 ? 62 : len > 40 ? 74 : 86;
}
