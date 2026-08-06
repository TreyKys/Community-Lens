// Share-to-bot intake: turn something the operator sent into a
// draftable post.
//
// Reply discovery used to be a metered scanner reading target
// timelines. It is now "you see a post while scrolling and share it to
// the bot" — which is free, needs no scraping, and is better targeted,
// because whether a post is worth replying under is judgement rather
// than retrieval.
//
// Getting the TEXT of a shared post is the only interesting problem.
// Three routes, cheapest first:
//
//   1. The operator pasted the text. Costs nothing, always works.
//   2. oEmbed (publish.twitter.com). Public, unauthenticated, free.
//      Whether it still works in 2026 is genuinely uncertain — X has
//      been shutting these doors for years — so it is attempted, not
//      relied upon.
//   3. A billed X API read, $0.005. OFF by default (allow_paid_lookup),
//      because the whole point of this change was to put the budget
//      into posts. A silent per-share charge is exactly the drip that
//      makes a budget wrong.
//
// If all three fail we ask the operator to paste the text. Asking is
// always better than spending money they did not agree to.

import crypto from 'crypto';
import { fetchWithTimeout } from './selfCall';
import { reserve, refund } from './budget';

export type SharedPost = {
  postId: string;          // real X id, or 'text:<sha1>' for pasted text
  author: string;
  text: string;
  url: string | null;
  /** How the text was obtained — surfaced to the operator. */
  via: 'pasted' | 'oembed' | 'api';
};

/**
 * Pull the author and post id out of an X permalink.
 *
 * Handles x.com and twitter.com, /status/ and /statuses/, query strings
 * (the share sheet appends ?s=20&t=…), and trailing slashes. Returns
 * null for anything that is not a post link.
 */
export function parsePostUrl(input: string): { author: string; postId: string; url: string } | null {
  // Digit count is deliberately unbounded at the low end. Modern
  // snowflake ids are 19 digits, but early tweets have short ones
  // (jack's first is literally id 20) and there is nothing to gain by
  // rejecting them — requiring a run of digits is already what
  // distinguishes a post link from a profile or list URL.
  const match = input.match(
    /https?:\/\/(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})/i,
  );
  if (!match) return null;

  const [, author, postId] = match;
  return { author, postId, url: `https://x.com/${author}/status/${postId}` };
}

/** Does this message contain an X link at all? */
export function looksLikePostUrl(input: string): boolean {
  return parsePostUrl(input) !== null;
}

/**
 * Free, unauthenticated tweet text via oEmbed.
 *
 * Returns null on any failure — this endpoint is a convenience, not a
 * contract, and X may withdraw it without notice. Never throws, so the
 * caller can just fall through to the next route.
 */
export async function fetchViaOEmbed(
  url: string,
): Promise<{ text: string; author: string } | null> {
  try {
    const endpoint =
      'https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=' + encodeURIComponent(url);
    const r = await fetchWithTimeout(endpoint, {}, 12_000);
    if (!r.ok) return null;

    const json = await r.json();
    const html = String(json?.html ?? '');
    if (!html) return null;

    // The embed is a <blockquote> whose first <p> holds the post text.
    // Strip tags, decode the handful of entities X emits, collapse
    // whitespace. Anything left after the trailing "— Name (@handle)"
    // attribution is dropped.
    const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!pMatch) return null;

    const text = pMatch[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();

    if (!text) return null;

    const author = String(json?.author_name ?? '').trim() || 'unknown';
    return { text, author };
  } catch {
    return null;
  }
}

/**
 * Billed fallback: read the post through the X API. $0.005.
 *
 * Reserves budget first like every other metered call, and refunds if
 * the post turns out to be unreachable (deleted, protected) so a dead
 * link does not quietly cost money.
 */
async function fetchViaApi(postId: string): Promise<{ text: string; author: string } | null> {
  const { isXConfigured } = await import('./x');
  if (!isXConfigured()) return null;

  const res = await reserve('post_read', { units: 1 });
  if (!res.ok) return null;

  try {
    const { xGetPost } = await import('./x');
    const post = await xGetPost(postId);
    if (!post) {
      await refund('post_read', 1);
      return null;
    }
    return { text: post.text, author: post.authorUsername ?? 'unknown' };
  } catch {
    await refund('post_read', 1);
    return null;
  }
}

export type IngestResult =
  | { ok: true; post: SharedPost }
  | { ok: false; reason: 'not_a_post' | 'no_text'; hint: string };

/**
 * Turn a Telegram message into something we can draft against.
 *
 * `allowPaidLookup` comes from social_settings, so the operator decides
 * whether a share may ever cost $0.005 — the default is no.
 */
export async function ingestShared(
  message: string,
  opts: { allowPaidLookup?: boolean } = {},
): Promise<IngestResult> {
  const trimmed = message.trim();
  const parsed = parsePostUrl(trimmed);

  // A URL plus extra words: treat the extra words as the text the
  // operator pasted alongside it. Saves a lookup entirely.
  const withoutUrl = parsed
    ? trimmed.replace(/https?:\/\/\S+/g, '').trim()
    : trimmed;

  if (parsed) {
    if (withoutUrl.length >= 15) {
      return {
        ok: true,
        post: {
          postId: parsed.postId,
          author: parsed.author,
          text: withoutUrl,
          url: parsed.url,
          via: 'pasted',
        },
      };
    }

    const oembed = await fetchViaOEmbed(parsed.url);
    if (oembed) {
      return {
        ok: true,
        post: {
          postId: parsed.postId,
          author: parsed.author,
          text: oembed.text,
          url: parsed.url,
          via: 'oembed',
        },
      };
    }

    if (opts.allowPaidLookup) {
      const api = await fetchViaApi(parsed.postId);
      if (api) {
        return {
          ok: true,
          post: {
            postId: parsed.postId,
            author: parsed.author,
            text: api.text,
            url: parsed.url,
            via: 'api',
          },
        };
      }
    }

    return {
      ok: false,
      reason: 'no_text',
      hint:
        `Couldn't read that post for free.\n\n` +
        `Send the link again with the post's text pasted underneath, and I'll draft from that — ` +
        `no API cost.\n\n` +
        `Or /paidlookup on to allow a $0.005 read per share.`,
    };
  }

  // No link — treat the whole message as the post's text. Synthetic id
  // so a double-paste of the same content dedupes.
  if (trimmed.length >= 15) {
    const hash = crypto.createHash('sha1').update(trimmed).digest('hex').slice(0, 16);
    return {
      ok: true,
      post: {
        postId: `text:${hash}`,
        author: 'unknown',
        text: trimmed,
        url: null,
        via: 'pasted',
      },
    };
  }

  return {
    ok: false,
    reason: 'not_a_post',
    hint:
      `Send me an X post link, or paste the text of a post, and I'll draft a reply.\n\n` +
      `/help for everything else.`,
  };
}
