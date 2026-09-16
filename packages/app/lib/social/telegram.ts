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
//
// ── who can command it vs. where it posts ───────────────────────────
//
// TELEGRAM_CHAT_ID is the DESTINATION — where cards and notifications
// get sent. TELEGRAM_ALLOWED_USER_IDS is WHO may command the bot —
// checked against the sender of an incoming message or button tap.
//
// These used to be the same value, because in a private 1:1 chat with
// the bot they ARE the same value (a private chat's id equals the
// user's own id). That stopped being safe to assume the moment the bot
// can be added to a GROUP: a group's chat id is a large negative
// number, not anyone's user id, so comparing a sender's id against it
// would reject every command from everyone. TELEGRAM_ALLOWED_USER_IDS
// falls back to TELEGRAM_CHAT_ID when unset, so nothing changes for an
// existing private-chat setup — it only matters once TELEGRAM_CHAT_ID
// is switched to point at a group.
//
// ── retrying a send ──────────────────────────────────────────────────
//
// Every Telegram call in this file goes through tg() below, so this is
// the one place a retry-with-backoff fixes every call site at once.
// Two failure modes are worth retrying automatically rather than
// surfacing immediately:
//
//   429 — Telegram's own per-chat rate limit. A burst of a dozen
//   sendPhoto calls in one digest run can trip this; Telegram's
//   response names the exact wait in `retry_after`, which is honoured
//   rather than guessed, because guessing shorter just earns a second
//   429.
//
//   5xx / a network error — Telegram's side, or the connection, having
//   a moment. A short fixed backoff and a couple of retries covers the
//   realistic transient case without ever bothering the operator.
//
// A genuine 4xx (bad chat id, wrong token, malformed payload) is NOT
// retried — the request will fail identically every time, so retrying
// only adds delay before the caller finds out.

import { fetchWithTimeout } from './selfCall';

const TG = 'https://api.telegram.org';
const MAX_ATTEMPTS = 3;

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

/** Telegram user ids allowed to command the bot. See the note above. */
export function allowedUserIds(): string[] {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_CHAT_ID || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isAllowedUser(userId: string | number | null | undefined): boolean {
  const id = String(userId ?? '').trim();
  return id.length > 0 && allowedUserIds().includes(id);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  let lastErr: Error = new Error(`telegram ${method}: no attempt made`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let r: Response;
    try {
      r = await fetchWithTimeout(`${TG}/bot${botToken()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      // The request never reached Telegram — a connection-level
      // failure. Worth a short retry; not worth burning every attempt
      // on, since a dead connection rarely heals in milliseconds.
      lastErr = new Error(`telegram ${method} network error: ${e?.message ?? e}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(attempt * 1000); continue; }
      break;
    }

    const json = await r.json().catch(() => ({}));
    if (r.ok && json?.ok !== false) return json.result;

    lastErr = new Error(`telegram ${method} failed ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);

    if (r.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(json?.parameters?.retry_after ?? 1);
      await sleep((retryAfter + 0.5) * 1000);
      continue;
    }

    if (r.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(attempt * 1000);
      continue;
    }

    // A genuine bad request (400/401/403/...) will fail the same way
    // every time — stop rather than spend the remaining attempts on it.
    break;
  }

  throw lastErr;
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

export type ReadyCard = {
  postId: number;
  body: string;
  mediaUrl?: string;
};

function readyButtons(postId: number) {
  return [[
    { text: '✅ Posted', callback_data: `rpost:${postId}` },
    { text: '📤 Own image', callback_data: `rup:${postId}` },
    { text: '🗑 Discard', callback_data: `rdisc:${postId}` },
  ]];
}

/**
 * A post ready for the operator to publish themselves.
 *
 * Sent as a photo with the post text as its CAPTION rather than as a
 * separate message — Telegram makes a caption copyable the same way a
 * <code> block is, so this collapses what used to be two messages (a
 * text card, then a follow-up "here is the image" reply) into one. At
 * the volume this pipeline runs at now, that difference is the whole
 * length of a review session.
 */
export async function sendReadyCard(card: ReadyCard): Promise<number> {
  const caption = escapeHtml(card.body).slice(0, 1000);

  if (card.mediaUrl) {
    // Stored uploads carry a 'tg:' prefix (see media.ts) so they are
    // never confused with a fetchable URL; strip it here the same way
    // sendPhotoPreview does, or a re-sent /drafts card would hand
    // Telegram the literal string "tg:AgAC..." as a photo URL.
    const photo = card.mediaUrl.startsWith('tg:') ? card.mediaUrl.slice(3) : card.mediaUrl;
    const result = await tg('sendPhoto', {
      chat_id: chatId(),
      photo,
      caption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: readyButtons(card.postId) },
    });
    return Number(result?.message_id ?? 0);
  }

  // No image at all — same buttons, plain text card.
  const result = await tg('sendMessage', {
    chat_id: chatId(),
    text: caption,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: readyButtons(card.postId) },
  });
  return Number(result?.message_id ?? 0);
}

/** Replace a ready card's buttons once the operator has decided. */
export async function markReadyHandled(messageId: number, outcome: 'posted' | 'discarded'): Promise<void> {
  const label = outcome === 'posted' ? '✅ Posted' : '🗑 Discarded';
  await tg('editMessageReplyMarkup', {
    chat_id: chatId(),
    message_id: messageId,
    reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] },
  });
}

/**
 * Swap a ready card's photo in place after the operator uploads their
 * own — editMessageMedia, not a new message, so the card keeps its
 * position in the chat and the operator does not end up with two
 * versions of the same post to choose between.
 */
export async function swapReadyCardPhoto(
  messageId: number,
  postId: number,
  fileId: string,
  caption: string,
): Promise<void> {
  await tg('editMessageMedia', {
    chat_id: chatId(),
    message_id: messageId,
    media: {
      type: 'photo',
      media: fileId,
      caption: escapeHtml(caption).slice(0, 1000),
      parse_mode: 'HTML',
    },
    reply_markup: { inline_keyboard: readyButtons(postId) },
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

/**
 * For a message important enough that missing it silently would be
 * worse than the operator getting told twice.
 *
 * notify() already retries transient failures inside tg() — this is
 * for what happens once those retries are exhausted, which means
 * Telegram itself is not taking messages right now, not just one call
 * hitting a rate limit. Telling the operator "Telegram is down" BY
 * SENDING THEM A TELEGRAM MESSAGE obviously will not work, so this
 * falls back to email — the one channel that does not share Telegram's
 * failure mode. Silently gives up only if email is not configured
 * either (RESEND_API_KEY unset), matching sendOpsEmail's own no-op.
 */
export async function notifyOrEscalate(text: string, emailSubject: string): Promise<void> {
  try {
    await notify(text);
  } catch (e: any) {
    const { sendOpsEmail } = await import('@/lib/ops-email');
    const plain = text.replace(/<[^>]+>/g, '');
    await sendOpsEmail({
      subject: emailSubject,
      html:
        `<p>Telegram would not take this after retrying:</p>` +
        `<p><code>${String(e?.message ?? e).replace(/</g, '&lt;').slice(0, 300)}</code></p>` +
        `<pre>${plain.replace(/</g, '&lt;')}</pre>`,
    }).catch(() => {});
  }
}
