// Slot assignment for hand-picked drafts.
//
// The planner walks the day's slots in order because it fills them all
// at once. A draft picked from Telegram at 08:40 needs the next slot
// that is both in the future and not already spoken for — otherwise two
// approvals in a row would collide on the same minute and the publisher
// would fire them back to back, which is exactly the shape a spam
// filter looks for.

import { getSupabaseAdmin } from '@/lib/oracle';

/** UTC hours, matching the planner. WAT is UTC+1. */
export const SLOTS_UTC = [7, 12, 17, 20];

/**
 * The soonest slot that is still ahead of us and has nothing queued
 * against it, searching up to `daysAhead` days out.
 *
 * Returns null if every slot in range is taken — the caller should say
 * so rather than silently stacking another post onto an occupied one.
 */
export async function nextFreeSlot(daysAhead = 3): Promise<Date | null> {
  const supa = getSupabaseAdmin();
  const now = Date.now();

  const horizon = new Date(now + daysAhead * 24 * 3600 * 1000).toISOString();
  const { data: taken } = await supa
    .from('social_posts')
    .select('scheduled_at')
    .in('status', ['queued', 'publishing'])
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', horizon);

  const occupied = new Set(
    (taken ?? []).map((r: any) => new Date(r.scheduled_at).getTime()),
  );

  for (let day = 0; day <= daysAhead; day++) {
    for (const hour of SLOTS_UTC) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + day);
      d.setUTCHours(hour, 0, 0, 0);

      // A slot only a few minutes away is no good — the publisher runs
      // hourly, so it would be missed and then aged out as stale.
      if (d.getTime() < now + 10 * 60 * 1000) continue;
      if (occupied.has(d.getTime())) continue;

      return d;
    }
  }

  return null;
}

/** "Fri 18:00 WAT" — how a slot is shown to the operator. */
export function formatSlot(d: Date): string {
  return d.toLocaleString('en-NG', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
    hour12: false,
  }) + ' WAT';
}
