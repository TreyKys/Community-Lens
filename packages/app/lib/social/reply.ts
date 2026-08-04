// Reply drafting.
//
// The reply is the growth lever. An account this size gets essentially
// no distribution on its own posts — the audience is borrowed from
// whoever you reply under, which is why 40 replies beat 40 posts by a
// wide margin and why this file matters more than compose.ts does.
//
// Two rules shape the prompt:
//
//  1. The reply must earn its place in someone else's mentions. A reply
//     that markets Opinions.ng gets ignored or ratioed. A reply that
//     adds one genuinely interesting thing gets profile clicks, and the
//     profile is where the product lives.
//  2. It must never read as automated. Anything that pattern-matches to
//     "AI reply guy" is what X's spam heuristics are tuned to catch,
//     and the account only has to be caught once.

import { stripLinks, containsLink } from './cost';
import { fetchWithTimeout } from './selfCall';
import { sanitisePost } from './compose';

const GEMINI_MODEL = 'gemini-2.5-flash';

const REPLY_VOICE = `You are a sharp, well-informed Nigerian voice on X replying to someone else's post. You happen to run a prediction market, but you are NOT here to advertise it.

Write ONE reply.

What makes a good reply:
- It adds something the original poster did not say — a number, a piece of history, a sharper framing, or a genuine counterpoint.
- It sounds like a person typing on their phone. Contractions, natural rhythm, occasional fragment.
- 1-2 sentences. Under 200 characters. Short replies outperform long ones.
- It can disagree. Mild, specific disagreement gets far more engagement than agreement.

Hard rules — breaking any of these makes the reply unusable:
- NEVER mention Opinions.ng, any product, any app, or "our platform". Not once. No self-promotion of any kind.
- NEVER include a URL or a domain.
- No hashtags. Ever.
- No emoji unless the original post's tone genuinely invites exactly one.
- Do not open with "Great point", "Absolutely", "This.", "Interesting take", or any other filler opener. Start with the substance.
- Do not restate the original post back at them.
- No betting advice, no odds claims, no "guaranteed", no financial promises.
- Do not invent statistics. If you are not sure of a number, make the point without one.
- If the post is about death, illness, tragedy, an accident, crime, or active political conflict, reply with exactly: SKIP`;

/** Reply-specific rejects, on top of the shared compliance checks. */
const REPLY_BANNED = [
  /opinions\.?ng/i,
  /our (platform|app|market|site)/i,
  /\bsign up\b/i,
  /check (us|it) out/i,
  /#\w+/,             // no hashtags at all in replies
  /^(great point|absolutely|this\.|interesting take|well said|so true)/i,
];

export function replyViolation(text: string): string | null {
  if (containsLink(text)) return 'contains a link';
  for (const re of REPLY_BANNED) {
    if (re.test(text)) return `matched ${re}`;
  }
  if (text.length > 240) return 'too long';
  return null;
}

async function callGemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1.0, maxOutputTokens: 200 },
      }),
    },
  );

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${t.slice(0, 300)}`);
  }

  const json = await r.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text');
  return String(text);
}

export type ReplyInput = {
  authorHandle: string;
  authorLabel: string | null;
  sourceText: string;
};

/**
 * Draft a reply, or null when the post should be left alone.
 *
 * Null is a completely normal outcome — most posts do not deserve a
 * reply from a brand-adjacent account, and the model is explicitly told
 * to emit SKIP on anything sensitive. A quiet scan is a working scan.
 */
export async function draftReply(input: ReplyInput): Promise<string | null> {
  const prompt = `${REPLY_VOICE}

You are replying to @${input.authorHandle}${input.authorLabel ? ` (${input.authorLabel})` : ''}:

"""
${input.sourceText.slice(0, 800)}
"""

Output only the reply text, or the single word SKIP.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callGemini(prompt);
      if (/^\s*SKIP\s*$/i.test(raw)) return null;

      const text = stripLinks(sanitisePost(raw));
      if (!text) continue;
      if (!replyViolation(text)) return text;
    } catch {
      // Retry once, then give up quietly — the scan logs the miss.
    }
  }
  return null;
}
