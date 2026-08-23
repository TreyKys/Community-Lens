import webpush from 'web-push';

// Web Push, server side.
//
// GATED ON CONFIG, NOT ON CODE. Nothing here throws or logs when the VAPID
// keys are absent — the whole feature simply reports itself unconfigured and
// every caller no-ops. That is deliberate: this ships before the keys exist,
// and a build that crashes on a missing env var would block the deploy of
// everything else in the same commit.
//
// Generate the pair once, with:
//
//   npx web-push generate-vapid-keys
//
// then set NEXT_PUBLIC_VAPID_PUBLIC_KEY (the browser needs it to subscribe),
// VAPID_PRIVATE_KEY, and VAPID_SUBJECT (a mailto: for your own domain — push
// services use it to reach you if you start flooding them).

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@opinionsng.com';

export const pushConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY);

if (pushConfigured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

export type PushTarget = {
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

// 'gone' means the browser threw this subscription away — uninstalled, cleared
// site data, or just expired. It is the one outcome that should be written back
// to the database, because retrying it forever is the main way a push table
// rots. Everything else is transient and worth another go on the next sweep.
export type PushResult = { ok: true } | { ok: false; gone: boolean; reason: string };

export async function sendPush(target: PushTarget, payload: PushPayload): Promise<PushResult> {
  if (!pushConfigured) return { ok: false, gone: false, reason: 'push not configured' };

  try {
    await webpush.sendNotification(
      {
        endpoint: target.endpoint,
        keys: { p256dh: target.p256dh, auth: target.auth },
      },
      JSON.stringify(payload),
      {
        // Notifications about money are worth waking a sleeping device for.
        urgency: 'high',
        // If the device is offline, a settlement notice is still worth
        // delivering an hour later; a day later it is noise.
        TTL: 60 * 60 * 4,
      },
    );
    return { ok: true };
  } catch (e: any) {
    const status = Number(e?.statusCode || 0);
    return {
      ok: false,
      // 404: the endpoint never existed. 410: it did and is now retired.
      gone: status === 404 || status === 410,
      reason: `${status || 'err'} ${String(e?.body || e?.message || e).slice(0, 160)}`,
    };
  }
}

// What a phone notification should actually say.
//
// The in-app `message` is written for a list where the type is already visible
// as an icon and a heading. On a lock screen there is no list and no icon, so
// the title has to carry the category by itself — "Opinions.ng" as a title for
// every notification tells someone nothing about whether to unlock the phone.
const TITLES: Record<string, string> = {
  bet_won: 'You won',
  bet_lost: 'Result is in',
  bet_refund: 'Refunded',
  open_market_payout: 'Paid out',
  open_market_refund: 'Refunded',
  open_market_horizon: 'Decision needed',
  open_market_submitted: 'Market submitted',
  open_market_approved: 'Market approved',
  open_market_revise: 'Changes requested',
  open_market_rejected: 'Market rejected',
  open_market_creator_payout: 'Creator earnings',
  streak_reward: 'Streak reward',
  profile_reward: 'Bonus added',
  referral_bonus: 'Referral bonus',
  deposit: 'Deposit confirmed',
  withdrawal: 'Withdrawal update',
};

export function pushTitle(type: string): string {
  return TITLES[type] || 'Opinions.ng';
}
