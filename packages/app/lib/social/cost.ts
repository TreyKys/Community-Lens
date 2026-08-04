// X API rate card and the link-detection that protects us from it.
//
// X retired the free/Basic/Pro tiers for new developers in Feb 2026 and
// moved to metered pay-per-use. There is no monthly minimum — you pay
// per call — which is what makes a ₦10k/month budget viable at all. But
// the rate card has one very sharp edge:
//
//     post_create ......... $0.015
//     post_create_link .... $0.200    <- 13.3x for containing a URL
//     post_read ........... $0.005
//     user_lookup ......... $0.001
//
// Verify against the developer portal before trusting these to the
// naira; X moves pricing and this file is the single place to change it.

export const X_RATES = {
  post_create: 0.015,
  post_create_link: 0.2,
  post_read: 0.005,
  user_lookup: 0.001,
} as const;

export type XOperation = keyof typeof X_RATES;

// Deliberately broad. A false positive costs us nothing (we rewrite the
// copy); a false negative costs 13.3x. Matches bare domains too, because
// "check opinionsng.com" is a link as far as X's billing is concerned —
// it autolinks in the timeline, so it bills as one.
const LINK_PATTERN =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ng|io|co|org|net|gg|tv|app|xyz)\b)/i;

export function containsLink(text: string): boolean {
  return LINK_PATTERN.test(text);
}

/**
 * Strip anything that would bill as a link, then tidy the whitespace the
 * removal leaves behind.
 *
 * This is the composer's last line of defence — Gemini is told not to
 * emit URLs but models drift, and one stray "opinionsng.com" in a daily
 * post is $0.185 of pure waste every day. The database CHECK constraint
 * catches whatever gets past this.
 */
export function stripLinks(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/\b[a-z0-9-]+\.(com|ng|io|co|org|net|gg|tv|app|xyz)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Which rate a call actually bills at. `post_create` is upgraded to the
 * link rate when the body would bill as one, so callers cannot
 * accidentally under-reserve for a post that turns out to be 13.3x more
 * expensive than they estimated.
 */
export function effectiveOperation(op: XOperation, body?: string): XOperation {
  if (op === 'post_create' && body && containsLink(body)) return 'post_create_link';
  return op;
}

/** What a call will cost, in USD. */
export function estimateCost(op: XOperation, units = 1, body?: string): number {
  return Number((X_RATES[effectiveOperation(op, body)] * units).toFixed(5));
}

/** Naira view of a USD figure, for operator-facing messages. */
export function usdToNgn(usd: number, rate = Number(process.env.NGN_PER_USD || 1550)): number {
  return Math.round(usd * rate);
}
