import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/oracle';
import { safeEqual } from '@/lib/safeCompare';
import { answerCallback, markCardHandled, notify } from '@/lib/social/telegram';
import { budgetSummary } from '@/lib/social/budget';

// POST /api/social/telegram
//
// Telegram webhook. Handles the button taps on a reply card.
//
// Auth is the secret-token header Telegram echoes back on every
// delivery. This endpoint is necessarily public — Telegram's servers
// call it — so without that check anyone who found the URL could mark
// replies as posted and corrupt the funnel numbers.
//
// Note what this endpoint deliberately does NOT do: it does not post to
// X. "Posted" means the operator already pasted it in the native app.
// Sending via API would cost $0.015 a reply — about $18/month at 40 a
// day, roughly 3x the entire budget — and native posts carry better
// distribution anyway. The button is bookkeeping, not a trigger.

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const provided = request.headers.get('x-telegram-bot-api-secret-token');
  if (!safeEqual(provided, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    // 200, not 401. Telegram retries non-2xx responses for a long time,
    // and there is nothing to retry here.
    return NextResponse.json({ ok: true });
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const cb = update?.callback_query;
  if (!cb) {
    // A plain text message — support one operator command.
    const text = String(update?.message?.text ?? '').trim().toLowerCase();
    if (text === '/budget') {
      const b = await budgetSummary().catch(() => null);
      if (b) {
        await notify(
          `<b>X budget</b>\n` +
          `Spent: $${b.spentUsd.toFixed(3)} (₦${b.spentNgn.toLocaleString()})\n` +
          `Cap: $${b.capUsd.toFixed(2)} (₦${b.capNgn.toLocaleString()})\n` +
          `Left: $${b.remainingUsd.toFixed(3)} — ${100 - b.pctUsed}%`,
        ).catch(() => {});
      }
    }
    return NextResponse.json({ ok: true });
  }

  const data = String(cb.data ?? '');
  const [action, rawId] = data.split(':');
  const replyId = Number(rawId);

  if (!Number.isFinite(replyId) || !['posted', 'skip'].includes(action)) {
    await answerCallback(cb.id, 'Nothing to do').catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const supa = getSupabaseAdmin();

  // Only move rows still awaiting a decision, so a double-tap on an old
  // card cannot flip an already-resolved row.
  const { data: updated } = await supa
    .from('social_replies')
    .update(
      action === 'posted'
        ? { status: 'posted', posted_via: 'manual', approved_at: new Date().toISOString() }
        : { status: 'rejected' },
    )
    .eq('id', replyId)
    .in('status', ['drafted', 'sent_to_review'])
    .select('id, telegram_message_id');

  if (!updated?.length) {
    await answerCallback(cb.id, 'Already handled').catch(() => {});
    return NextResponse.json({ ok: true });
  }

  const messageId = Number(updated[0].telegram_message_id ?? cb.message?.message_id ?? 0);
  if (messageId) {
    await markCardHandled(messageId, action === 'posted' ? 'posted' : 'skipped').catch(() => {});
  }

  await answerCallback(cb.id, action === 'posted' ? 'Logged ✅' : 'Skipped').catch(() => {});
  return NextResponse.json({ ok: true });
}
