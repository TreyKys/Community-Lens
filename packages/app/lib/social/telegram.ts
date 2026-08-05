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
  const permalink = `https://x.com/${card.author}/status/${card.sourcePostId}`;

  const text =
    `<b>@${escapeHtml(card.author)}</b>\n` +
    `<blockquote>${escapeHtml(card.sourceText.slice(0, 280))}</blockquote>\n\n` +
    `<b>Draft reply</b> — tap to copy:\n` +
    `<code>${escapeHtml(card.draft)}</code>`;

  const result = await tg('sendMessage', {
    chat_id: chatId(),
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        // Opens the native app on a phone; falls back to web on desktop.
        [{ text: 'Open in X', url: permalink }],
        [
          { text: 'Posted', callback_data: `posted:${card.replyId}` },
          { text: 'Skip', callback_data: `skip:${card.replyId}` },
        ],
      ],
    },
  });

  return Number(result?.message_id ?? 0);
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
