// Briefed drafting: posts written from what the operator asked for.
//
// compose.ts writes posts ABOUT markets — it takes a market row and
// turns its odds into copy. That is the right engine for "the split
// moved", and the wrong one for everything else, which is most of what
// an audience actually wants to read.
//
// It also failed in a specific way worth remembering: ranked by which
// market closed soonest, it surfaced Dutch second-division fixtures
// whose auto-seeded titles were barely English ("Cambuur vs Excelsior
// (DED)"), with no pool data to quote. Given nothing to say, the model
// echoed the title.
//
// Here the operator supplies the subject: "4 BBN posts", "3 posts about
// the Super Eagles squad". Live markets are offered as OPTIONAL
// context the model may reach for if genuinely relevant, and ignore
// otherwise — a Big Brother Naija post has no business quoting a
// Portuguese league fixture.

import { getSupabaseAdmin } from '@/lib/oracle';
import { sanitisePost, violatesCompliance, sentimentFromPools } from './compose';
import { generate, GeminiTruncatedError } from './gemini';
import { researchBrief, type Research } from './research';

/** Hard ceiling per brief. More than this is unreviewable on a phone. */
export const MAX_DRAFTS = 6;
export const DEFAULT_DRAFTS = 3;

const VOICE = `You write for Opinions.ng — Nigeria's event-derivative market, where people take positions against each other on football, politics, pop culture and the economy.

Audience: Nigerian, online, on X. They follow football and Big Brother Naija and know the naira's mood. Write for them, not for a global audience.

Voice: hard, kinetic, confident, no fluff. A sharp friend in the group chat who happens to have the numbers — not a brand account.

Hard rules:
- Under 240 characters. Shorter is better.
- NEVER include a URL, a domain, or anything like "opinionsng.com". Not once. This is absolute.
- At most ONE hashtag, and only when it is a genuine live conversation tag. Usually zero.
- No "click the link", no "sign up", no call-to-action.
- One emoji at most. Usually none.
- Never promise or imply a guaranteed return. Never "sure bet", "guaranteed", "free money", "can't lose". This is a regulated financial product in Nigeria.
- Never tell anyone what to pick. You can say what a crowd thinks; you cannot advise.
- Do not invent statistics, scores, or quotes. If you are not certain of a number, make the point without one.
- Each post must stand alone and be about a DIFFERENT angle. Do not write four versions of one thought.`;

export type BriefRequest = {
  brief: string;
  count: number;
};

/**
 * Pull "4" and the subject out of what the operator typed.
 *
 * Deliberately forgiving — this gets typed one-handed on a phone before
 * work. "4 BBN posts", "draft four posts about BBN", and "BBN" should
 * all work, the last one falling back to the default count.
 */
export function parseBrief(input: string): BriefRequest {
  // Strip the command word FIRST, so "/draft 4 BBN posts" and
  // "4 BBN posts" parse identically. Doing this after the count match
  // meant a leading "/draft" hid the leading digit and every command
  // silently fell back to the default count.
  const raw = input.trim().replace(/^\/?(?:draft|write|post)\b\s*/i, '').trim();

  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  };

  let count = DEFAULT_DRAFTS;
  // A leading digit, or "3 posts" / "5 tweets" anywhere in the line —
  // the count trails the subject as often as it leads it.
  const digit = raw.match(/^(\d+)\b/) || raw.match(/\b(\d+)\s+(?:posts?|tweets?|drafts?)\b/i);
  const word = raw.match(/\b(one|two|three|four|five|six)\s+(?:posts?|tweets?|drafts?)\b/i);

  if (digit) count = Number(digit[1]);
  else if (word) count = WORDS[word[1].toLowerCase()];

  count = Math.max(1, Math.min(count, MAX_DRAFTS));

  // Strip the counting scaffolding so only the SUBJECT reaches the
  // model. "4 BBN posts" -> "BBN". Leaving "posts" in tempts the model
  // into writing about posting.
  const brief = raw
    .replace(/^\s*\d+\b/, '')
    .replace(/\b(?:one|two|three|four|five|six|\d+)\s+(?:posts?|tweets?|drafts?)\b/gi, '')
    .replace(/\b(?:posts?|tweets?|drafts?)\s+(?:about|on|regarding|re)\b/gi, '')
    .replace(/^\s*(?:please|pls|can you|could you)\b/i, '')
    .replace(/^\s*(?:about|on|regarding|re)\b\s*/i, '')
    .replace(/\b(?:posts?|tweets?|drafts?)\s*$/i, '')
    .replace(/[\s,;.]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { brief: brief || raw, count };
}

/**
 * A compact digest of what is live on the site.
 *
 * Offered, never imposed. The prompt tells the model to use it only if
 * the brief genuinely relates — otherwise a BBN post would end up
 * quoting a Portuguese fixture because the numbers were sitting there.
 *
 * Capped at 8 and skewed toward markets with real money on them, since
 * a market nobody has bet on has no interesting number to quote.
 */
export async function marketContext(limit = 8): Promise<string> {
  try {
    const supa = getSupabaseAdmin();
    const { data } = await supa
      .from('markets')
      .select('id, question, options, closes_at, pool_by_outcome, seed_pool, league_code')
      .eq('status', 'open')
      .gt('closes_at', new Date().toISOString())
      .order('closes_at', { ascending: true })
      .limit(40);

    if (!data?.length) return '';

    const withSplit = data
      .map((m: any) => {
        const pcts = sentimentFromPools(m);
        const hasRealMoney = Object.values(m.pool_by_outcome ?? {}).some((v) => Number(v) > 0);
        return { m, pcts, hasRealMoney };
      })
      // Real money first — those are the only ones with a number worth
      // repeating.
      .sort((a, b) => Number(b.hasRealMoney) - Number(a.hasRealMoney))
      .slice(0, limit);

    const lines = withSplit.map(({ m, pcts }) => {
      const q = String(m.question).replace(/\[.*?\]\s*/g, '').trim();
      const split = pcts
        ? (m.options as string[]).map((o, i) => `${o} ${pcts[i]}%`).join(' / ')
        : 'no meaningful split yet';
      return `- ${q} — ${split}`;
    });

    return lines.join('\n');
  } catch {
    return '';
  }
}


/**
 * Split a numbered list into individual posts.
 *
 * The model is asked for "1. ... 2. ..." and mostly complies, but drops
 * into bullets or blank-line-separated paragraphs often enough that
 * both need handling — a parse failure here would waste the whole call.
 */
export function splitDrafts(raw: string): string[] {
  let t = raw.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();

  // Preferred shape: lines starting 1. / 2) / 3 -
  const numbered = t
    .split(/\n(?=\s*\d{1,2}\s*[.)\-:])/)
    .map((s) => s.replace(/^\s*\d{1,2}\s*[.)\-:]\s*/, '').trim())
    .filter(Boolean);

  if (numbered.length > 1) return numbered;

  // Bulleted.
  const bulleted = t
    .split(/\n(?=\s*[-*•]\s)/)
    .map((s) => s.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);

  if (bulleted.length > 1) return bulleted;

  // Blank-line separated paragraphs.
  const paras = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (paras.length > 1) return paras.map(stripListMarker);

  // Single item. It still needs its marker stripped — when a truncated
  // response contained only "1. ..." the split above found nothing to
  // split on, fell through to here, and the "1. " went out on the card.
  return t ? [stripListMarker(t)] : [];
}

/** Remove a leading "1." / "2)" / "- " list marker. */
function stripListMarker(s: string): string {
  return s.replace(/^\s*(?:\d{1,2}\s*[.)\-:]|[-*•])\s*/, '').trim();
}

export type DraftResult = {
  drafts: string[];
  rejected: Array<{ text: string; reason: string }>;
  /** The model hit its output limit; fewer posts came back than asked. */
  truncated: boolean;
  /** What the grounded search turned up, if anything. */
  research: Research | null;
};

/**
 * Write `count` posts from the operator's brief.
 *
 * Anything failing a compliance guard is dropped and reported rather
 * than silently swapped for something else — if three of four drafts
 * tripped a rule, that is worth knowing about the brief.
 */
export async function draftFromBrief(
  req: BriefRequest,
  opts: { includeMarkets?: boolean; research?: boolean } = {},
): Promise<DraftResult> {
  // Research first. A post about what happened last night beats a post
  // about the general nature of the thing, every time — and only one of
  // those can start a conversation on X.
  const research = opts.research === false ? null : await researchBrief(req.brief);

  const context = opts.includeMarkets === false ? '' : await marketContext();

  const prompt = `${VOICE}

The operator has asked for:

"""
${req.brief}
"""

Write exactly ${req.count} DIFFERENT posts answering that brief. Each one a separate angle.

${research ? `RESEARCH — real, current, searched moments ago. Build every post on THIS, not on general knowledge about the subject.

${research.findings}

How to use it:
- Name the specifics. "Kola went at 12%" lands; "there was an eviction" does not.
- Prefer the ARGUMENTS over the events. Pick a side of a live disagreement and say something a reader could disagree with. A post nobody can argue with is a post nobody replies to.
- Do NOT invent anything absent from the research above. No scores, names, dates or percentages of your own.
- If one finding is thin, use a different one rather than padding it into a whole post.
- Do not write "reportedly" or "sources say". Either it is in the research or it does not go in the post.
` : ''}
${context ? `Currently live on the site — use ONLY if the brief genuinely relates to one of these. If the brief is about something else, ignore this list entirely and do not mention markets or odds:

${context}
` : ''}
Output ONLY a numbered list, one post per line, like:
1. <post>
2. <post>

No preamble, no commentary, no markdown, no quotes around the posts.`;

  let raw: string;
  let truncated = false;
  try {
    raw = await generate(prompt, { temperature: 1.0, maxOutputTokens: 1500 });
  } catch (e) {
    if (e instanceof GeminiTruncatedError) {
      // Salvage the complete posts from the fragment and flag it. The
      // last item is mid-sentence, so it is dropped below.
      raw = e.partial;
      truncated = true;
    } else {
      throw e;
    }
  }

  const pieces = splitDrafts(raw);

  // A truncated response ends mid-sentence, so its final item is not a
  // usable post. Publishing half a thought is worse than returning one
  // fewer draft.
  if (truncated && pieces.length > 1) pieces.pop();

  const drafts: string[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];

  for (const piece of pieces) {
    const text = sanitisePost(piece);
    if (!text) continue;

    const violation = violatesCompliance(text);
    if (violation) {
      rejected.push({ text, reason: violation });
      continue;
    }

    // Cheap near-duplicate guard: models asked for four angles will
    // sometimes hand back the same sentence with a synonym swapped.
    const normalised = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const dupe = drafts.some((d) => {
      const other = d.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      return other === normalised || other.startsWith(normalised.slice(0, 40));
    });
    if (dupe) continue;

    drafts.push(text);
    if (drafts.length >= req.count) break;
  }

  return { drafts, rejected, truncated, research };
}
