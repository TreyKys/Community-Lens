// Turns live markets into post copy.
//
// The strategic bet here: a prediction market's most shareable asset is
// its own odds. "Arsenal at 47% and it hasn't moved since the team
// sheet dropped" is a post nobody else on Nigerian X can write, it is
// interesting on its own terms, and it costs nothing to produce because
// the number is already in Supabase.
//
// That is why nothing in this file batches generic content on a Sunday.
// Content is DERIVED from the product on the day it is relevant, which
// also means it cannot go stale between authoring and publishing — the
// failure mode where an injury on Monday makes a Wednesday post
// embarrassing.
//
// Voice comes from marketing/post1-manifesto.brief.md: hard, kinetic,
// no fluff, no hashtag soup.

import { getSupabaseAdmin } from '@/lib/oracle';
import { stripLinks, containsLink } from './cost';

const GEMINI_MODEL = 'gemini-2.5-flash';

export type PostKind = 'opening_line' | 'movement' | 'settlement' | 'evergreen';

const VOICE = `You write for Opinions.ng — Nigeria's event-derivative market. Nigerian audience, Nigerian references, naira.

Voice: hard, kinetic, confident, no fluff. You sound like a sharp friend in the group chat who happens to have the numbers, not like a brand account.

Hard rules:
- Under 240 characters. Shorter is better.
- NEVER include a URL, a domain, or anything like "opinionsng.com". Not once. This is absolute.
- At most ONE hashtag, and only when it is a real live conversation tag. Usually zero.
- No "Click the link", no "Sign up", no call-to-action of any kind.
- No emoji spam. One, or none.
- Never promise or imply a guaranteed return. Never say "sure bet", "guaranteed", "free money", "can't lose". This is a regulated financial product in Nigeria.
- Never give betting advice or tell anyone what to pick. State what the market says; let the reader draw the conclusion.
- Do not invent numbers. Use only the figures given to you.`;

type MarketRow = {
  id: string;
  question: string;
  options: string[];
  closes_at: string;
  home_team: string | null;
  away_team: string | null;
  sport: string | null;
  league_code: string | null;
  description: string | null;
  pool_by_outcome: Record<string, number> | null;
  seed_pool: Record<string, number> | null;
};

/**
 * Effective sentiment per outcome, as whole percentages.
 *
 * Mirrors lib/sentiment.ts — seed pool plus real stakes — so a post can
 * never quote a percentage that differs from what the market page
 * shows. Reads the denormalised pool_by_outcome instead of summing
 * user_bets, because the planner runs over every open market and the
 * per-bet sum would be N queries.
 */
export function sentimentFromPools(m: MarketRow): number[] | null {
  const n = Array.isArray(m.options) ? m.options.length : 0;
  if (!n) return null;

  const totals = Array.from({ length: n }, (_, i) => {
    const real = Number(m.pool_by_outcome?.[String(i)] ?? 0);
    const seed = Number(m.seed_pool?.[String(i)] ?? 0);
    return (Number.isFinite(real) && real > 0 ? real : 0) + (Number.isFinite(seed) && seed > 0 ? seed : 0);
  });

  const sum = totals.reduce((s, v) => s + v, 0);
  if (sum <= 0) return null;
  return totals.map((v) => Math.round((v / sum) * 100));
}

/** The one-line fact block Gemini is allowed to draw numbers from. */
function marketFacts(m: MarketRow, kind: PostKind): string {
  const pcts = sentimentFromPools(m);
  const lines: string[] = [`Market: ${m.question}`];

  if (m.home_team && m.away_team) lines.push(`Fixture: ${m.home_team} vs ${m.away_team}`);
  if (m.league_code) lines.push(`Competition: ${m.league_code}`);
  if (m.description) lines.push(`Context: ${m.description}`);

  if (pcts) {
    const split = (m.options || [])
      .map((o, i) => `${o} ${pcts[i]}%`)
      .join(' · ');
    lines.push(`Where the money is: ${split}`);
  } else {
    lines.push('Where the money is: market just opened, no meaningful split yet.');
  }

  lines.push(`Closes: ${new Date(m.closes_at).toUTCString()}`);
  lines.push(`Post type: ${kind}`);
  return lines.join('\n');
}

const KIND_BRIEF: Record<PostKind, string> = {
  opening_line:
    'The market just opened. Frame the question and the opening split. Make someone want to disagree with the crowd.',
  movement:
    'The split has moved. Lead with the movement — what changed and how fast. Movement is the story, not the fixture.',
  settlement:
    'The market resolved. Say what happened and what the crowd had thought beforehand. Dry, factual, a little wry if the crowd was wrong.',
  evergreen:
    'No specific market. Write about how prediction markets differ from betting: you take a position against other people, not against a house.',
};

async function callGemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 300 },
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

/**
 * Clean up whatever the model actually returned.
 *
 * Models wrap output in quotes, prefix it with "Here's a post:", and
 * emit markdown fences even when told not to — the same drift
 * app/api/admin/generate-markets/route.ts already defends against.
 * Doing it here means the caller never has to care.
 */
export function sanitisePost(raw: string): string {
  let t = raw.trim();

  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  // Drop a leading "Post:" / "Tweet:" / "Here's ...:" preamble.
  t = t.replace(/^(here'?s?[^:\n]{0,40}:|post:|tweet:|option \d:)\s*/i, '').trim();
  // Unwrap surrounding quotes, but only if BOTH ends have them.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }

  t = stripLinks(t);

  // Hard cap below the DB constraint (270) and X's limit (280), cutting
  // at a word boundary so we never publish a severed word.
  if (t.length > 250) {
    t = t.slice(0, 250);
    const lastSpace = t.lastIndexOf(' ');
    if (lastSpace > 180) t = t.slice(0, lastSpace);
    t = t.replace(/[,;:\-–—]\s*$/, '').trim();
  }

  return t;
}

/** Phrases that must never leave the account. Checked after generation. */
const BANNED = [
  /guarantee/i,
  /\bsure bet\b/i,
  /can'?t lose/i,
  /free money/i,
  /risk[- ]free/i,
  /\beasy money\b/i,
];

export function violatesCompliance(text: string): string | null {
  for (const re of BANNED) {
    if (re.test(text)) return `matched banned phrase ${re}`;
  }
  if (containsLink(text)) return 'contains a link';
  return null;
}

/**
 * Draft one post for one market. Returns null when the result cannot be
 * made safe — the planner skips rather than publishing something that
 * needed a human, and a skipped slot is always cheaper than a bad post
 * from a licensed financial product.
 */
export async function composeMarketPost(m: MarketRow, kind: PostKind): Promise<string | null> {
  const prompt = `${VOICE}

${KIND_BRIEF[kind]}

${marketFacts(m, kind)}

Write ONE post. Output only the post text — no preamble, no quotes, no markdown.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = sanitisePost(await callGemini(prompt));
      if (!text) continue;
      if (!violatesCompliance(text)) return text;
    } catch {
      // Fall through to the retry; the planner logs the miss.
    }
  }
  return null;
}

/** Load open markets worth posting about, newest close first. */
export async function openMarkets(limit = 40): Promise<MarketRow[]> {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from('markets')
    .select('id, question, options, closes_at, home_team, away_team, sport, league_code, description, pool_by_outcome, seed_pool')
    .eq('status', 'open')
    .gt('closes_at', new Date().toISOString())
    .order('closes_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`market load failed: ${error.message}`);
  return (data ?? []) as MarketRow[];
}
