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

  const today = new Date().toISOString().split('T')[0];

  const prompt = `Today is ${today}. Research this subject for a Nigerian audience on X: ${brief}

Run SEVERAL different searches, not one. Look for the latest news, and separately for what people are arguing about — those are different queries and both matter.

Return TWO sections.

=== WHAT HAPPENED ===
Specific events from the last 7 days. Every line must contain at least one PROPER NOUN (a person, a team, a place) or a NUMBER. A line with neither is useless — drop it.

Good:  "Sun 3 Aug — Kola was evicted with 12% of the vote, the narrowest margin this season"
Good:  "Tue — Ada and Chidi's argument over the food budget ran 40 minutes on the live feed"
Bad:   "there was drama in the house this week"
Bad:   "housemates continue to form alliances"

=== WHAT PEOPLE ARE ARGUING ABOUT ===
The live disagreements. For each: the claim, and what the other side says.

This section matters MORE than the first. A post about something that happened gets read; a post that takes a side in an argument already running gets replies. Give me the fault lines.

Good:  "Half the timeline says Kola was robbed by the vote split; the other half says he coasted for three weeks and deserved it"
Bad:   "viewers have different opinions about the eviction"

Rules:
- Anything you cannot attribute to something you actually found, leave out. Do not pad.
- Names and spellings exactly as the sources have them.
- If a claim is a rumour, say whose rumour it is.
- Max 6 lines per section, newest first.
- No preamble, no summary, no closing thought. Just the two sections.

If searching turns up nothing from the last 7 days, reply with exactly: NOTHING RECENT`;

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
            // Two sections of six lines, plus room for the thinking
            // this call deliberately leaves enabled. Sized generously
            // because a truncated research block silently produces
            // thin posts rather than an error.
            maxOutputTokens: 3000,
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
