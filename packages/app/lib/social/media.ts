// Choosing and resolving a post's image.
//
// Three states, held in social_posts.media_kind:
//
//   none      — text only
//   auto_card — we render the post's own words as an anticipation card
//   upload    — the operator sent a photo from their phone
//
// The upload case stores `tg:<file_id>` rather than a URL, because
// Telegram's download links are signed and expire in about an hour. A
// post queued at 08:40 for a 18:00 slot would find a dead link. The
// file_id never expires, so it is resolved to a fresh URL at publish
// time instead.

import { getSupabaseAdmin, getBaseUrl } from '@/lib/oracle';
import { fetchWithTimeout } from './selfCall';

export type MediaKind = 'none' | 'auto_card' | 'upload';

/** The rendered-card URL for a post. */
export function autoCardUrl(postId: number): string {
  return `${getBaseUrl()}/api/social/card/post/${postId}`;
}

/**
 * Turn a stored media_url into something fetchable right now.
 *
 * `tg:<file_id>` is resolved through getFile, which returns a path
 * valid for roughly an hour — long enough for the publisher to
 * download it in the next second, and deliberately not stored.
 */
export async function resolveMediaUrl(stored: string): Promise<string> {
  if (!stored.startsWith('tg:')) return stored;

  const fileId = stored.slice(3);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('cannot resolve a Telegram photo: TELEGRAM_BOT_TOKEN is not set');

  const r = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    {},
    15_000,
  );
  const json = await r.json().catch(() => ({}));
  const path = json?.result?.file_path;
  if (!r.ok || !path) {
    throw new Error(`Telegram getFile failed for ${fileId}: ${JSON.stringify(json).slice(0, 200)}`);
  }

  return `https://api.telegram.org/file/bot${token}/${path}`;
}

/**
 * Set a post's image.
 *
 * media_kind and media_url move together — the database constraint
 * requires it, so "no image" genuinely clears the URL rather than
 * leaving a stale one the publisher would still attach.
 */
export async function setMedia(
  postId: number,
  kind: MediaKind,
  opts: { fileId?: string; kicker?: string; theme?: string } = {},
): Promise<void> {
  const supa = getSupabaseAdmin();

  const patch: Record<string, unknown> = { media_kind: kind };

  if (kind === 'none') {
    patch.media_url = null;
  } else if (kind === 'auto_card') {
    patch.media_url = autoCardUrl(postId);
    if (opts.kicker) patch.card_kicker = opts.kicker.slice(0, 24);
    if (opts.theme) patch.card_theme = opts.theme;
  } else {
    if (!opts.fileId) throw new Error('upload requires a Telegram file_id');
    patch.media_url = `tg:${opts.fileId}`;
  }

  const { error } = await supa.from('social_posts').update(patch).eq('id', postId);
  if (error) throw new Error(`could not set media: ${error.message}`);
}

// ── "which post is waiting for a photo" ─────────────────────────────
//
// A photo arrives as its own Telegram message with nothing tying it to
// a post. Replying to the card is the reliable signal; this is the
// fallback for when the operator just sends one.

/** How long a parked Upload stays claimable. */
const AWAIT_WINDOW_MS = 10 * 60 * 1000;

export async function awaitMediaFor(postId: number): Promise<void> {
  const supa = getSupabaseAdmin();
  await supa
    .from('social_settings')
    .update({ awaiting_media_post_id: postId, awaiting_media_since: new Date().toISOString() })
    .eq('id', 1);
}

export async function clearAwaitingMedia(): Promise<void> {
  const supa = getSupabaseAdmin();
  await supa
    .from('social_settings')
    .update({ awaiting_media_post_id: null, awaiting_media_since: null })
    .eq('id', 1);
}

/**
 * Which post, if any, a loose photo belongs to.
 *
 * Expires after ten minutes. Without that, a photo sent hours later —
 * to a group, by accident — would silently attach itself to a post the
 * operator had forgotten about, and the first they would know is seeing
 * it published.
 */
export async function pendingMediaPost(): Promise<number | null> {
  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from('social_settings')
    .select('awaiting_media_post_id, awaiting_media_since')
    .eq('id', 1)
    .maybeSingle();

  const id = (data as any)?.awaiting_media_post_id;
  const since = (data as any)?.awaiting_media_since;
  if (!id || !since) return null;

  if (Date.now() - new Date(since).getTime() > AWAIT_WINDOW_MS) {
    await clearAwaitingMedia();
    return null;
  }

  return Number(id);
}
