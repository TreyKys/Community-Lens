/**
 * "More about this market" — a short, neutral background panel for the
 * Open Markets trading page, built with the shared Gemini client.
 *
 * The one rule everything here is built around: this is background on the
 * SUBJECT of the question, never an opinion on the ANSWER. "Will fuel prices
 * go up?" gets a note on what moves fuel prices generally — never a guess at
 * which way they're headed. This platform prices that question with real
 * money; the moment this panel reads as the house's view on the outcome, it
 * stops being neutral context and starts being something closer to a tip,
 * on a market the house itself is the counterparty to. The prompt refuses
 * that explicitly, and the parser drops anything that slips through looking
 * like a probability or a verdict.
 */

import { generate, GeminiTruncatedError } from './social/gemini';

export type ContextItem = { title: string; body: string };

const MAX_ITEMS = 4;
const MIN_TITLE = 3;
const MAX_TITLE = 60;
const MIN_BODY = 20;
const MAX_BODY = 280;

export function buildContextPrompt(market: {
  question: string;
  description: string | null;
  category: string;
  resolutionSource: string;
}): string {
  return `You write short, neutral background notes for a Nigerian prediction-market site. Real money trades on the answer to the question below, so your job is background on the SUBJECT — never a guess, hint or lean on the answer itself.

Question: "${market.question}"
${market.description ? `Extra context given by whoever posted it: "${market.description}"\n` : ''}Category: ${market.category}
Settled against: ${market.resolutionSource}

Write exactly ${MAX_ITEMS} short items of general background a reader would find useful before deciding how they feel about this question. Think: what is this about, what has driven it historically, what would a well-informed Nigerian reader already want to know. Do NOT:
- state or imply which way it will go, a probability, or anything that reads as a prediction
- invent a specific statistic, date or figure you are not confident is true — write in general, verifiable terms instead
- mention this website, trading, odds, shares or prices
- write "this could go either way" or any other coy non-answer — just don't address the outcome at all

Output EXACTLY this format, nothing else — no numbering, no markdown, no preamble:

TITLE: <3-6 word title>
BODY: <one or two plain sentences>

TITLE: <3-6 word title>
BODY: <one or two plain sentences>

(repeat for all ${MAX_ITEMS} items)`;
}

/**
 * Parses the TITLE:/BODY: block format above. Deliberately not JSON — the
 * shared Gemini client (lib/social/gemini.ts) has already been bitten once by
 * models wrapping JSON in markdown fences or trailing it with commentary, and
 * this format degrades gracefully: a malformed block is just dropped rather
 * than failing the whole parse.
 */
export function parseContextItems(raw: string): ContextItem[] {
  const items: ContextItem[] = [];
  const blocks = raw.split(/\n\s*\n/);

  for (const block of blocks) {
    const titleMatch = block.match(/TITLE:\s*(.+)/i);
    const bodyMatch = block.match(/BODY:\s*([\s\S]+)/i);
    if (!titleMatch || !bodyMatch) continue;

    const title = titleMatch[1].trim().replace(/\*\*/g, '');
    const body = bodyMatch[1].trim().replace(/\*\*/g, '').replace(/\s+/g, ' ');

    if (title.length < MIN_TITLE || title.length > MAX_TITLE) continue;
    if (body.length < MIN_BODY || body.length > MAX_BODY) continue;

    // A stray probability is exactly the thing the prompt forbids and a
    // model can still slip in — catch the obvious forms rather than trust
    // the instruction alone.
    if (/\b\d{1,3}\s?%/.test(body)) continue;

    items.push({ title, body });
    if (items.length >= MAX_ITEMS) break;
  }

  return items;
}

/**
 * Generate the panel for one market. Throws on any failure — the route
 * decides what a caller sees on failure (stale cache, or nothing), this
 * function just does the one job of asking Gemini and parsing the answer.
 */
export async function generateMarketContext(market: {
  question: string;
  description: string | null;
  category: string;
  resolutionSource: string;
}): Promise<ContextItem[]> {
  const prompt = buildContextPrompt(market);
  let raw: string;
  try {
    // Short, factual, low temperature — this is background reference copy,
    // not the varied social voice the rest of the Gemini pipeline writes in.
    raw = await generate(prompt, { temperature: 0.4, maxOutputTokens: 700 });
  } catch (e) {
    if (e instanceof GeminiTruncatedError) raw = e.partial;
    else throw e;
  }

  const items = parseContextItems(raw);
  if (items.length === 0) throw new Error('Gemini response had no usable items');
  return items;
}
