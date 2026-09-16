import { NextResponse } from 'next/server';
import { safeSecretMatch } from '@/lib/safeCompare';
import { redeliverPendingCards } from '@/lib/social/ready';
import { notifyOrEscalate } from '@/lib/social/telegram';

// POST /api/social/redeliver
//
// Runs every 20 minutes. Finds draft cards that were written but never
// reached Telegram — makeReadyPost() already retries three times with
// backoff internally (see telegram.ts's tg()), so a row still missing
// its provider_post_id after several minutes means Telegram itself was
// unreachable for the whole run, not a one-off blip. This is the
// second, slower line of retry for that case.
//
// Deliberately does NOT check settings.publishingPaused — a paused
// pipeline still owes the operator delivery of cards it already wrote
// and told them about; pause stops NEW work, not redelivery of old.

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!safeSecretMatch(cronSecret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await redeliverPendingCards();

  // Quiet when there was nothing to do — this runs every 20 minutes,
  // and a message every run would drown out everything else in the chat.
  if (result.attempted === 0) {
    return NextResponse.json(result);
  }

  if (result.stillFailing.length) {
    await notifyOrEscalate(
      `<b>${result.stillFailing.length} card${result.stillFailing.length === 1 ? '' : 's'} still cannot reach Telegram</b> ` +
      `after another retry (post id${result.stillFailing.length === 1 ? '' : 's'}: ${result.stillFailing.join(', ')}). ` +
      `Will keep retrying every 20 minutes.`,
      'Opinions.ng social bot — Telegram still unreachable',
    );
  } else if (result.delivered) {
    await notifyOrEscalate(
      `<i>${result.delivered} card${result.delivered === 1 ? '' : 's'} that failed to send earlier just went out — check above.</i>`,
      'Opinions.ng social bot — delayed cards delivered',
    );
  }

  return NextResponse.json(result);
}
