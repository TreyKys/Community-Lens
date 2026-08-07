// Grounded research: find out what is ACTUALLY happening before writing.
//
// Without this the drafter has only its training data, so "4 BBN posts"
// produces takes that are true of Big Brother Naija in general and of
// no season in particular:
//
//   "From BBN housemate to Nollywood star? It's a path many try..."
//   "BBN or Naija Super Eagles? For some, the drama..."
//
// Both are fine sentences. Neither could start a conversation, because
// neither refers to anything that happened this week. On X, currency is
// the whole game — a post about last night's eviction gets replies, a
// post about the concept of reality TV gets scrolled past.
//
// So: one grounded search call per brief, whose findings are handed to
// the drafter as facts it may use. Deliberately a SEPARATE call from
// drafting, for three reasons: the drafting prompt keeps its tuned
// voice and its thinkingBudget: 0; the findings can be shown to the
// operator, who is the one who knows whether they are actually true;
// and if research fails, drafting still runs.
//
// Cost: Google's search grounding is free to 1,500 requests/day and
// $35/1,000 after. A handful of briefs a day is nowhere near that, so
// this is effectively free — unlike the X API, it does not need a
// budget ledger.

import { fetchWithTimeout } from './selfCall';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export type Research = {
  findings: string;
  /** Pages the model actually consulted, for the operator to sanity-check. */
  sources: string[];
};

/**
 * Ask Gemini, with live Google Search, what is currently happening
 * around the brief.
 *
 * Returns null on any failure. Research is an enhancement — a brief
 * that cannot be researched should still produce posts, just generic
 * ones, which is exactly where we were before.
 */
export async function researchBrief(brief: string): Promise<Research | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const prompt = `Search for what is happening RIGHT NOW with: ${brief}

Focus on Nigeria and a Nigerian audience.

Report back ONLY concrete, recent, checkable facts — things that happened in the last few days. For each one give the fact and roughly when it happened.

Good: "Sunday 3 Aug: <specific person> was evicted after <specific thing>"
Bad: "the show is popular and generates a lot of conversation"

If you cannot find anything recent and specific, say exactly: NOTHING RECENT

Rules:
- No speculation, no rumour, no "reportedly" unless you name who reported it.
- Names spelled as the sources spell them.
- At most 8 findings, newest first.
- No preamble. Just the list.`;

  try {
    const r = await fetchWithTimeout(
      `${ENDPOINT}?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // Live Google Search. Only 2.x models take this shape; 1.5
          // used google_search_retrieval.
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,          // facts, not flair
            maxOutputTokens: 1200,
            // NOTE: thinking is deliberately left at its default here.
            // The model has to decide what to search for and reconcile
            // what comes back, which is the one place in this pipeline
            // where reasoning earns its tokens. maxOutputTokens is
            // sized to absorb it.
          },
        }),
      },
      45_000,  // a grounded call does real network work behind the scenes
    );

    if (!r.ok) return null;

    const json = await r.json();
    const candidate = json?.candidates?.[0];
    const text = String(candidate?.content?.parts?.[0]?.text ?? '').trim();

    if (!text || /^NOTHING RECENT$/im.test(text)) return null;

    // Grounding metadata names the pages actually consulted. Worth
    // surfacing: the operator can tell at a glance whether this came
    // from a news site or from a fan account inventing things.
    const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const sources: string[] = [];
    for (const c of chunks) {
      const title = c?.web?.title;
      if (title && !sources.includes(title)) sources.push(String(title));
    }

    return { findings: text, sources: sources.slice(0, 6) };
  } catch {
    return null;
  }
}
