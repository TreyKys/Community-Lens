// AI triage for user complaints — uses Gemini (same key the market
// generator uses) to classify the free-text description into the
// specific issue category that Mechanic's dispatch table can act on.
//
// This is deliberately narrow: input free-text + user-declared type,
// output structured category + confidence. Never used to make a money
// decision — only to pick which detector to run for a user's specific
// case (e.g. "my bet won't resolve" → scan their slips, not their
// deposits).

const CATEGORIES = [
  'bet_stuck',
  'slip_stuck',
  'deposit_missing',
  'withdrawal_delayed',
  'balance_wrong',
  'other',
] as const;

type TriageCategory = typeof CATEGORIES[number];

export interface TriageResult {
  category: TriageCategory;
  confidence: number;                      // 0–1
  reasoning: string;                        // short, one line
  suggestedActionForUser: string;           // friendly one-liner for the response
  usedAI: boolean;                          // false when we fell back to the user-declared type
}

const SYSTEM_PROMPT = `You are the triage step for a betting/prediction market app's user complaint system.

Given a user's free-text description of what's wrong PLUS the category they picked from a dropdown, classify their issue into one of these exact strings:
  - bet_stuck            (a single bet or "pick" isn't showing resolved / stuck on active)
  - slip_stuck           (a multiplier / parlay / accumulator "slip" isn't showing resolved)
  - deposit_missing      (they paid in but their balance didn't go up)
  - withdrawal_delayed   (they requested a withdrawal but haven't received it)
  - balance_wrong        (their balance is off by an amount they can quantify)
  - other                (nothing above fits)

Consider "bet_stuck" and "slip_stuck" different — a slip is a multi-leg accumulator; a single bet is one prediction. Pick slip_stuck if they mention multiple markets/picks in one ticket, multiplier, parlay, or "accumulator". Otherwise bet_stuck.

Return ONLY valid JSON matching this exact shape, no prose, no markdown:
{
  "category": "<one of the strings above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one short sentence>",
  "suggestedActionForUser": "<one friendly sentence to include in the response — do NOT promise a fix, just acknowledge what we're going to check>"
}`;

// Fallback map: if the AI call fails or times out, use the user's own
// dropdown selection. Nothing is ever left ambiguous.
const USER_TYPE_TO_CATEGORY: Record<string, TriageCategory> = {
  bet_stuck: 'bet_stuck',           // covers both singles and slips at fallback
  deposit_missing: 'deposit_missing',
  withdrawal_delayed: 'withdrawal_delayed',
  balance_wrong: 'balance_wrong',
  other: 'other',
};

export async function triageComplaint(input: {
  userDeclaredType: string;
  description: string | null;
  context?: Record<string, any>;
}): Promise<TriageResult> {
  const fallbackCategory = USER_TYPE_TO_CATEGORY[input.userDeclaredType] || 'other';
  const geminiKey = process.env.GEMINI_API_KEY;

  const fallback = (): TriageResult => ({
    category: fallbackCategory,
    confidence: 0.5,
    reasoning: 'Using user-selected type (AI triage unavailable).',
    suggestedActionForUser: 'We&#39;re looking into it and will get back to you shortly.',
    usedAI: false,
  });

  if (!geminiKey) return fallback();
  if (!input.description || input.description.trim().length < 3) return fallback();

  const userPrompt = `User-selected type: ${input.userDeclaredType}

Free-text description:
"""
${input.description.slice(0, 2000)}
"""`;

  const timeoutMs = 6000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 300,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
    if (!res.ok) return fallback();
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(text);
    if (!CATEGORIES.includes(parsed.category)) return fallback();
    return {
      category: parsed.category,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reasoning: String(parsed.reasoning || '').slice(0, 200),
      suggestedActionForUser: String(parsed.suggestedActionForUser || 'We&#39;re looking into it and will get back to you shortly.').slice(0, 300),
      usedAI: true,
    };
  } catch {
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}
