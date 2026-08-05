// X API v2 client — writes, reads, and media upload.
//
// Auth: OAuth 1.0a user-context, signed here rather than pulled in as a
// dependency. v2 posting accepts OAuth 1.0a and it is the only scheme
// that works for both the v2 write endpoints and the v1.1 media upload
// we need for image posts, so one signer covers everything. OAuth 2.0
// PKCE would need a refresh-token dance and a place to store the
// rotating token; for a single first-party account that is strictly
// more moving parts.
//
// Every metered call reserves budget first — see ./budget.

import crypto from 'crypto';
import { reserve, refund } from './budget';
import { containsLink } from './cost';
import { fetchWithTimeout, toInternalUrl } from './selfCall';

const API = 'https://api.x.com';
const UPLOAD = 'https://upload.twitter.com/1.1/media/upload.json';

type Creds = {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
};

function rawCreds() {
  return {
    appKey: process.env.X_API_KEY || '',
    appSecret: process.env.X_API_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessSecret: process.env.X_ACCESS_SECRET || '',
  };
}

/**
 * Are the X credentials present?
 *
 * Callers check this BEFORE touching the queue. Without it, deploying
 * the cron workflows before the keys are set would march every queued
 * post through three failed attempts and mark it dead — you would come
 * back to an empty queue and a table full of `failed` rows that were
 * never actually bad. Checking up front makes an unconfigured deploy a
 * clean no-op.
 */
export function isXConfigured(): boolean {
  return Object.values(rawCreds()).every(Boolean);
}

function creds(): Creds {
  const c = rawCreds();
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`X credentials missing: ${missing.join(', ')}`);
  return c;
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!*()']/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

/**
 * OAuth 1.0a HMAC-SHA1 signature.
 *
 * Only query-string params join the signature base for JSON requests —
 * a JSON body is NOT form-encoded into the base string, which is the
 * single most common way hand-rolled v2 signing goes wrong (it yields a
 * 401 that looks like bad credentials).
 */
function authHeader(method: string, url: string, queryParams: Record<string, string> = {}): string {
  const c = creds();
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.appKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: c.accessToken,
    oauth_version: '1.0',
  };

  const all = { ...oauth, ...queryParams };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join('&');

  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  const signingKey = `${enc(c.appSecret)}&${enc(c.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');

  return 'OAuth ' + Object.keys(oauth)
    .sort()
    .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
    .join(', ');
}

export class XApiError extends Error {
  constructor(message: string, readonly status: number, readonly billed: boolean) {
    super(message);
    this.name = 'XApiError';
  }
}

/**
 * Did this failure still cost money?
 *
 * 429 (rate limited) and 4xx validation errors are rejected before X
 * does the work, so they do not bill — we refund the reservation. A 5xx
 * may or may not have billed; we keep the debit, because assuming we
 * were not charged is the expensive assumption.
 */
function billedOnFailure(status: number): boolean {
  return status >= 500;
}

// ---------------------------------------------------------------- writes

export type PostResult = { id: string; text: string };

/**
 * Publish a post. `body` MUST be link-free — a URL makes this call
 * $0.20 instead of $0.015 and the caller has almost certainly not
 * budgeted for that, so we refuse rather than silently spend 13x.
 *
 * Links reach the audience through a manual reply from the phone
 * instead: free, and the timeline does not suppress it the way it
 * suppresses an outbound link in the parent post.
 */
export async function postToX(
  body: string,
  opts: { mediaIds?: string[]; replyToId?: string; refTable?: string; refId?: number } = {},
): Promise<PostResult> {
  if (containsLink(body)) {
    throw new Error(
      'refusing to post a body containing a link — X bills $0.20 vs $0.015. ' +
      'Put the link in a manual reply instead.',
    );
  }

  const res = await reserve('post_create', {
    body,
    refTable: opts.refTable,
    refId: opts.refId,
  });
  if (!res.ok) throw new Error(`budget: ${res.reason}`);

  const url = `${API}/2/tweets`;
  const payload: Record<string, unknown> = { text: body };
  if (opts.mediaIds?.length) payload.media = { media_ids: opts.mediaIds };
  if (opts.replyToId) payload.reply = { in_reply_to_tweet_id: opts.replyToId };

  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader('POST', url),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    if (!billedOnFailure(r.status)) await refund('post_create', 1, body);
    throw new XApiError(`X post failed ${r.status}: ${text.slice(0, 400)}`, r.status, billedOnFailure(r.status));
  }

  const json = await r.json();
  return { id: String(json?.data?.id ?? ''), text: String(json?.data?.text ?? body) };
}

// ---------------------------------------------------------------- media

/**
 * Upload an image and return its media_id.
 *
 * Media upload is not metered per the published rate card — only post
 * creation and reads are — so this does not touch the budget ledger.
 * It is still the slowest step, so the publisher fetches the card image
 * once and reuses the id for the life of a single post.
 */
export async function uploadMedia(imageUrl: string): Promise<string> {
  // Fetch our own card over loopback, not out through Caddy and back.
  // See lib/social/selfCall.ts — the public round trip is slow, breaks
  // while Caddy restarts during a deploy, and hangs outright on AWS
  // setups without hairpin NAT.
  const localUrl = toInternalUrl(imageUrl);

  // The card is an og render, which is the slowest thing we do — give
  // it more room than a normal API call, but still a hard ceiling.
  const img = await fetchWithTimeout(localUrl, {}, 30_000);
  if (!img.ok) throw new Error(`card image fetch failed ${img.status} for ${localUrl}`);

  const buf = Buffer.from(await img.arrayBuffer());
  // 5MB is X's image ceiling; our OG cards land around 100-300KB, so
  // blowing this means the card route returned something unexpected.
  if (buf.byteLength > 5 * 1024 * 1024) {
    throw new Error(`card image too large: ${buf.byteLength} bytes`);
  }

  const form = new URLSearchParams({ media_data: buf.toString('base64') });
  const r = await fetchWithTimeout(UPLOAD, {
    method: 'POST',
    headers: {
      // v1.1 upload signs the form body, unlike the v2 JSON endpoints.
      Authorization: authHeader('POST', UPLOAD, Object.fromEntries(form)),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new XApiError(`media upload failed ${r.status}: ${text.slice(0, 300)}`, r.status, false);
  }

  const json = await r.json();
  const id = json?.media_id_string;
  if (!id) throw new Error('media upload returned no media_id_string');
  return String(id);
}

// ---------------------------------------------------------------- reads

export type XPost = { id: string; text: string; authorId: string; createdAt: string };

/**
 * Resolve @handle -> numeric id. Cached in social_targets because it
 * bills, and a handle's id never changes.
 */
export async function lookupUserId(handle: string): Promise<string> {
  const res = await reserve('user_lookup');
  if (!res.ok) throw new Error(`budget: ${res.reason}`);

  const url = `${API}/2/users/by/username/${encodeURIComponent(handle)}`;
  const r = await fetchWithTimeout(url, { headers: { Authorization: authHeader('GET', url) } });

  if (!r.ok) {
    if (!billedOnFailure(r.status)) await refund('user_lookup');
    throw new XApiError(`user lookup failed ${r.status} for @${handle}`, r.status, billedOnFailure(r.status));
  }

  const json = await r.json();
  const id = json?.data?.id;
  if (!id) throw new Error(`no such X user: @${handle}`);
  return String(id);
}

/**
 * Newest posts from one account, excluding replies and retweets — we
 * only want original posts worth replying under.
 *
 * `maxResults` is the budget lever. Every post returned bills $0.005,
 * so pulling 5 costs $0.025 and pulling 100 costs $0.50. Default 5:
 * on a scan of 12 accounts that is $0.30/day, which is the difference
 * between fitting a ₦10k month and not.
 *
 * `sinceId` means a quiet account bills for nothing at all.
 */
export async function fetchRecentPosts(
  userId: string,
  opts: { maxResults?: number; sinceId?: string } = {},
): Promise<XPost[]> {
  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 5), 100);

  const res = await reserve('post_read', { units: maxResults });
  if (!res.ok) throw new Error(`budget: ${res.reason}`);

  const params: Record<string, string> = {
    max_results: String(maxResults),
    exclude: 'replies,retweets',
    'tweet.fields': 'created_at,author_id',
  };
  if (opts.sinceId) params.since_id = opts.sinceId;

  const url = `${API}/2/users/${userId}/tweets`;
  const qs = new URLSearchParams(params).toString();

  const r = await fetchWithTimeout(`${url}?${qs}`, {
    headers: { Authorization: authHeader('GET', url, params) },
  });

  if (!r.ok) {
    if (!billedOnFailure(r.status)) await refund('post_read', maxResults);
    throw new XApiError(`timeline read failed ${r.status}`, r.status, billedOnFailure(r.status));
  }

  const json = await r.json();
  const items: XPost[] = (json?.data ?? []).map((t: any) => ({
    id: String(t.id),
    text: String(t.text ?? ''),
    authorId: String(t.author_id ?? userId),
    createdAt: String(t.created_at ?? new Date().toISOString()),
  }));

  // X bills for what it returns, not what we asked for. Give back the
  // difference so a quiet timeline does not eat the full reservation.
  const unused = maxResults - items.length;
  if (unused > 0) await refund('post_read', unused);

  return items;
}
