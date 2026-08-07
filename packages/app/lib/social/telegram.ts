// Telegram — the operator's control surface.
//
// This is deliberately NOT a fire button. The reply card gives you the
// three things that actually take time on a phone:
//
//   1. a deep link that opens the post in the native X app,
//   2. the draft in a <code> block, which Telegram makes copyable with
//      one tap,
//   3. a "Done" button that closes the loop for measurement.
//
// You paste and post natively. That costs $0 against a metered API
// where each reply would be $0.015, and a natively-composed reply
// carries session signals an API post does not. The bottleneck was
// never typing — it was finding the post and having a take. Those are
// what the card removes.
//
// API sending exists behind SOCIAL_REPLY_MODE=api for when the budget
// justifies it, but manual is the default and the recommended mode.

import { fetchWithTimeout } from './selfCall';

const TG = 'https://api.telegram.org';

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return t;
}

function chatId(): string {
  const c = process.env.TELEGRAM_CHAT_ID;
  if (!c) throw new Error('TELEGRAM_CHAT_ID is not set');
  return c;
}

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetchWithTimeout(`${TG}/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json?.ok === false) {
    throw new Error(`telegram ${method} failed: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.result;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type ReplyCard = {
  replyId: number;
  author: string;
  sourceText: string;
  sourcePostId: string;
  draft: string;
};

/**
 * Push one reply card. Returns the Telegram message id so the row can
 * be edited in place when the operator acts on it.
 */
export async function sendReplyCard(card: ReplyCard): Promise<number> {
  // Text pasted without a link carries a synthetic 'text:<hash>' id, so
  // there is no permalink to open. Telegram rejects the whole message
  // if a URL button is malformed, which would lose the draft entirely —
  // so the button is only added when we have a real post id.
  const hasPermalink = /^\d+$/.test(card.sourcePostId) && card.author !== 'unknown';
  const permalink = `https://x.com/${card.author}/status/${card.sourcePostId}`;

  const buttons: Array<Array<Record<string, string>>> = [];
  if (hasPermalink) {
    // Opens the native app on a phone; falls back to web on desktop.
    buttons.push([{ text: 'Open in X', url: permalink }]);
  }
  buttons.push([
    { text: 'Posted', callback_data: `posted:${card.replyId}` },
    { text: 'Skip', callback_data: `skip:${card.replyId}` },
  ]);

  const heading = card.author === 'unknown' ? '<b>Shared post</b>' : `<b>@${escapeHtml(card.author)}</b>`;

  const text =
    `${heading}\n` +
    `<blockquote>${escapeHtml(card.sourceText.slice(0, 280))}</blockquote>\n\n` +
    `<b>Draft reply</b> — tap to copy:\n` +
    `<code>${escapeHtml(card.draft)}</code>`;

  const result = await tg('sendMessage', {
    chat_id: chatId(),
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
  });

  return Number(result?.message_id ?? 0);
}

export type DraftCard = {
  postId: number;
  index: number;
  total: number;
  body: string;
};

/**
 * One drafted post, awaiting a decision.
 *
 * Sent as its own message rather than a numbered list in a single
 * message, so each has its own buttons. Picking two of four is then two
 * taps, with no need to say WHICH two — which is the whole point of
 * reviewing on a phone before work.
 */
export async function sendDraftCard(card: DraftCard): Promise<number> {
  const text =
    `<b>Draft ${card.index}/${card.total}</b>  ·  ${card.body.length} chars\n\n` +
    `${escapeHtml(card.body)}`;

  const result = await tg('sendMessage', {
    chat_id: chatId(),
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[
        { text: '✓ Queue', callback_data: `qpost:${card.postId}` },
        { text: '✗ Discard', callback_data: `dpost:${card.postId}` },
      ]],
    },
  });

  return Number(result?.message_id ?? 0);
}

export type PreviewCard = {
  postId: number;
  index: number;
  total: number;
  body: string;
  when: string;
  mediaKind: 'none' | 'auto_card' | 'upload';
};

const MEDIA_LABEL: Record<PreviewCard['mediaKind'], string> = {
  none: 'no image',
  auto_card: 'OPx card (auto)',
  upload: 'your image',
};

/**
 * One queued post, with its image state and the controls to change it.
 *
 * The image row is spelled out rather than implied by a highlighted
 * button, because the thing being confirmed is "what will actually go
 * out", and a button that merely looks pressed is not an answer to
 * that.
 */
export async function sendPreviewCard(card: PreviewCard): Promise<number> {
  const text =
    `<b>#${card.postId}</b> · ${card.index}/${card.total} · ${escapeHtml(card.when)}\n` +
    `Image: <b>${MEDIA_LABEL[card.mediaKind]}</b>\n\n` +
    `${escapeHtml(card.body)}`;

  const rows: Array<Array<Record<string, string>>> = [
    [
      { text: card.mediaKind === 'auto_card' ? '🖼 Card ✓' : '🖼 Add card', callback_data: `mcard:${card.postId}` },
      { text: card.mediaKind === 'upload' ? '📤 Yours ✓' : '📤 Upload', callback_data: `mup:${card.postId}` },
    ],
    [
      { text: card.mediaKind === 'none' ? '🚫 No image ✓' : '🚫 No image', callback_data: `mnone:${card.postId}` },
      { text: '🗑 Cancel post', callback_data: `pcancel:${card.postId}` },
    ],
  ];

  const result = await tg('sendMessage', {
    chat_id: chatId(),
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: rows },
  });

  return Number(result?.message_id ?? 0);
}

/** Redraw a preview card in place after its image changed. */
export async function refreshPreviewCard(messageId: number, card: PreviewCard): Promise<void> {
  const text =
    `<b>#${card.postId}</b> · ${card.index}/${card.total} · ${escapeHtml(card.when)}\n` +
    `Image: <b>${MEDIA_LABEL[card.mediaKind]}</b>\n\n` +
    `${escapeHtml(card.body)}`;

  const rows: Array<Array<Record<string, string>>> = [
    [
      { text: card.mediaKind === 'auto_card' ? '🖼 Card ✓' : '🖼 Add card', callback_data: `mcard:${card.postId}` },
      { text: card.mediaKind === 'upload' ? '📤 Yours ✓' : '📤 Upload', callback_data: `mup:${card.postId}` },
    ],
    [
      { text: card.mediaKind === 'none' ? '🚫 No image ✓' : '🚫 No image', callback_data: `mnone:${card.postId}` },
      { text: '🗑 Cancel post', callback_data: `pcancel:${card.postId}` },
    ],
  ];

  await tg('editMessageText', {
    chat_id: chatId(),
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: rows },
  });
}

/**
 * Send an actual picture, so the operator sees what will be attached
 * rather than trusting a label that says an image exists.
 */
export async function sendPhotoPreview(source: string, caption: string): Promise<void> {
  // Telegram accepts either a public URL it will fetch, or one of its
  // own file_ids. An uploaded photo is already on their servers, so
  // passing the id back avoids a needless round trip through us.
  const photo = source.startsWith('tg:') ? source.slice(3) : source;

  await tg('sendPhoto', {
    chat_id: chatId(),
    photo,
    caption: caption.slice(0, 900),
    parse_mode: 'HTML',
  });
}

/** Replace a draft card's buttons with what was decided. */
export async function markDraftHandled(
  messageId: number,
  outcome: 'queued' | 'discarded',
  detail?: string,
): Promise<void> {
  const label = outcome === 'queued' ? `✅ Queued${detail ? ` · ${detail}` : ''}` : '🗑 Discarded';
  await tg('editMessageReplyMarkup', {
    chat_id: chatId(),
    message_id: messageId,
    reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] },
  });
}

/**
 * Collapse a card once it is handled, so a scrollback of forty cards
 * shows at a glance what is still outstanding.
 */
export async function markCardHandled(messageId: number, outcome: 'posted' | 'skipped'): Promise<void> {
  const mark = outcome === 'posted' ? '✅ Posted' : '⏭ Skipped';
  await tg('editMessageReplyMarkup', {
    chat_id: chatId(),
    message_id: messageId,
    reply_markup: { inline_keyboard: [[{ text: mark, callback_data: 'noop' }]] },
  });
}

export async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  await tg('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

/** Plain operator message — used by the daily digest and failure alerts. */
export async function notify(text: string): Promise<void> {
  await tg('sendMessage', {
    chat_id: chatId(),
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}
