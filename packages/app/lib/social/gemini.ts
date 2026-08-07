// One Gemini client for the whole social pipeline.
//
// This exists because the same bug was written three times.
//
// ── The thinking-token trap ─────────────────────────────────────────
// Gemini 2.5 models reason before answering, and — unlike OpenAI —
// Google counts those thinking tokens against maxOutputTokens. The
// budget is dynamic by default, and on anything non-trivial the model
// will spend 90-98% of it thinking. Whatever is left is all it has to
// write with.
//
// Every call site here had maxOutputTokens between 200 and 900, so in
// production the model thought its way through nearly the whole budget
// and emitted a fragment:
//
//   "Cambuur vs Excelsior (BTTS): will both"
//   "BBN is back and the TL is wild. ... The chatter? It"
//
// Both were cut mid-sentence, and a request for four posts returned
// one. It looked like bad source data. It was not.
//
// Two fixes, both needed:
//
//   1. thinkingBudget: 0. These are short-form copy tasks — "write a
//      tweet about BBN" needs voice, not a chain of reasoning. Zero
//      also means the lowest cost and latency.
//   2. A finishReason check. MAX_TOKENS means the response is a
//      fragment, and a fragment must be an error rather than something
//      we quietly publish under the brand's name.

import { fetchWithTimeout } from './selfCall';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export class GeminiTruncatedError extends Error {
  constructor(readonly partial: string) {
    super('Gemini hit the output token limit — response is a fragment');
    this.name = 'GeminiTruncatedError';
  }
}

export type GenerateOptions = {
  /** Sampling temperature. Higher for copy that must vary. */
  temperature?: number;
  /**
   * Tokens available FOR THE ANSWER. With thinking disabled this is the
   * real budget, so it can be sized to the output rather than padded to
   * absorb reasoning.
   */
  maxOutputTokens?: number;
  timeoutMs?: number;
};

/**
 * Generate text. Throws on truncation rather than returning a fragment.
 */
export async function generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const r = await fetchWithTimeout(
    `${ENDPOINT}?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.9,
          maxOutputTokens: opts.maxOutputTokens ?? 1200,
          // The fix. Without this the model spends the budget thinking
          // and returns a fragment — see the note at the top.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
    opts.timeoutMs ?? 30_000,
  );

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${t.slice(0, 300)}`);
  }

  const json = await r.json();
  const candidate = json?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  const finishReason = String(candidate?.finishReason ?? '');

  // MAX_TOKENS means we are holding half a sentence. Surfacing it lets
  // the caller retry or skip; returning it would publish the fragment.
  if (finishReason === 'MAX_TOKENS') {
    throw new GeminiTruncatedError(String(text ?? ''));
  }

  // SAFETY / RECITATION / PROHIBITED_CONTENT — the model declined.
  // Normal for a sensitive brief, and not something to retry blindly.
  if (!text) {
    throw new Error(
      finishReason
        ? `Gemini returned no text (finishReason: ${finishReason})`
        : 'Gemini returned no text',
    );
  }

  return String(text);
}
