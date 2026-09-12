// Turning an accepted draft into a "ready" card on the operator's phone.
//
// The single place a post becomes a social_posts row AND a Telegram
// message, used by both /draft (one topic, on demand) and the digest
// cron (several topics, on a schedule). Kept in one place so a bug in
// one is a bug in both, not a bug in one and a silent divergence in
// the other.
//
// "Ready" replaces "queued". There is no schedule any more — the
// operator posts these themselves, whenever they get to their phone —
// so a post has exactly two states worth a button: not yet posted, or
// decided (posted / discarded).

import { getSupabaseAdmin, getBaseUrl } from '@/lib/oracle';
import { randomThemeId } from './cardText';
import { setMedia, autoCardUrl } from './media';
import { sendReadyCard } from './telegram';

export type ReadyPostInput = {
  body: string;
  kind: string;
  brief?: string | null;
  /** Short eyebrow for the card — falls back to one derived from kind/brief. */
  kicker?: string | null;
  /** When set, the card shows this market's LIVE odds instead of the post's own text. */
  sourceMarketId?: number | null;
};

/**
 * Insert one post as a draft, attach its card, and push it to Telegram
 * as a ready-to-post card.
 *
 * Returns the post id, or null if the insert was rejected — in
 * practice almost always the market+kind dedupe index doing its job
 * when two runs overlap.
 */
export async function makeReadyPost(input: ReadyPostInput): Promise<number | null> {
  const supa = getSupabaseAdmin();

  const { data: row, error } = await supa
    .from('social_posts')
    .insert({
      channel: 'x',
      kind: input.kind,
      body: input.body,
      brief: input.brief ?? null,
      status: 'draft',
      source_market_id: input.sourceMarketId ?? null,
      card_theme: randomThemeId(),
      card_kicker: input.kicker ?? null,
    })
    .select('id')
    .single();

  if (error || !row) return null;

  const postId = row.id as number;

  // A market-linked post gets the live odds card; anything else gets
  // its own words rendered. Two statements because the card's URL
  // needs the row's own id — the same reason /preview's "Add card"
  // button sets media as a follow-up update rather than in the insert.
  const mediaUrl = input.sourceMarketId != null
    ? `${getBaseUrl()}/api/social/card/${input.sourceMarketId}`
    : autoCardUrl(postId);

  await setMedia(postId, 'auto_card', { url: mediaUrl }).catch(() => {});

  const messageId = await sendReadyCard({ postId, body: input.body, mediaUrl }).catch(() => 0);

  if (messageId) {
    await supa.from('social_posts').update({ provider_post_id: `tg:${messageId}` }).eq('id', postId);
  }

  return postId;
}
