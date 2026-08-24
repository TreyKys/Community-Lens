import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { safeSecretMatch } from '@/lib/safeCompare';
import { sendPush, pushConfigured, pushConfigError, pushTitle } from '@/lib/push';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/cron/push — deliver notifications to phones.
//
// SWEPT, NOT HOOKED. Notifications are written from a dozen places —
// settlement, streaks, profile rewards, the horizon cron, admin alerts — and
// several of them are SQL functions that cannot make an HTTP call at all.
// Hooking each write site would mean missing whichever one gets added next.
// Instead every notification row carries a `pushed_at` and this route pushes
// whatever is unpushed, so anything that writes a notification gets a phone
// notification for free, forever, including code nobody has written yet.
//
// MARKED PUSHED WHETHER OR NOT EVERY DEVICE ACCEPTED. A retry loop keyed on
// the notification would re-send to that person's WORKING devices every time
// one broken device failed. A push that is genuinely lost is lost; the in-app
// bell still has it.

const BATCH = 200;

export async function POST(request: Request) {
  if (!safeSecretMatch(request.headers.get('x-cron-secret'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Not an error. This ships before the VAPID keys exist and must stay quiet
  // until they do, or the cron logs fill with failures for a feature that was
  // deliberately left switched off.
  // Reports the SPECIFIC reason, not a generic "not configured". This response
  // is the only diagnostic an operator gets, and "not configured" reads as
  // "you have not set the variables" even when they are set and simply wrong —
  // which sends someone to re-add values that are already there.
  if (!pushConfigured) {
    return NextResponse.json({ skipped: pushConfigError, sent: 0 });
  }

  const { data, error } = await supabaseAdmin.rpc('pending_push_notifications', {
    p_limit: BATCH,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data || []) as Array<{
    notification_id: string;
    user_id: string;
    type: string;
    message: string;
    action_url: string | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    subscription_id: string;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, retired: 0, notifications: 0 });
  }

  let sent = 0;
  let failed = 0;
  const retired = new Set<string>();
  const touched = new Set<string>();

  // One row per (notification × device). Sent in parallel because each is a
  // separate HTTPS round trip to a push service that may be slow, and doing
  // two hundred of those in series is how a cron tick times out.
  const results = await Promise.all(
    rows.map(async r => {
      const res = await sendPush(
        {
          subscriptionId: r.subscription_id,
          endpoint: r.endpoint,
          p256dh: r.p256dh,
          auth: r.auth,
        },
        {
          title: pushTitle(r.type),
          body: r.message,
          url: r.action_url || '/',
          // Tagged per notification, not per type: two different settlements
          // are two different things to read, and tagging them alike would
          // make the second silently replace the first.
          tag: r.notification_id,
        },
      );
      return { r, res };
    }),
  );

  for (const { r, res } of results) {
    // Marked either way — see the note at the top. The notification was
    // attempted; whether one particular device took it is that device's
    // problem, and the in-app bell is the backstop.
    touched.add(r.notification_id);
    if (res.ok) sent++;
    else {
      failed++;
      if (res.gone) retired.add(`${r.subscription_id}|${res.reason}`);
    }
  }

  // Retire dead devices so the next sweep does not try them again. Doing this
  // before marking, so a crash in between costs a duplicate push rather than a
  // subscription that never gets cleaned up.
  for (const entry of Array.from(retired)) {
    const [id, reason] = entry.split('|');
    try {
      await supabaseAdmin.rpc('mark_push_subscription_failed', {
        p_subscription_id: id,
        p_reason: reason,
      });
    } catch { /* not worth failing the tick over */ }
  }

  const { data: marked } = await supabaseAdmin.rpc('mark_notifications_pushed', {
    p_ids: Array.from(touched),
  });

  return NextResponse.json({
    notifications: touched.size,
    marked: Number(marked || 0),
    sent,
    failed,
    retiredSubscriptions: retired.size,
    // A full batch means there is more waiting. Surfaced rather than looped:
    // the next tick picks it up, and a self-looping cron that falls behind
    // turns into a route that never returns.
    more: rows.length >= BATCH,
  });
}
