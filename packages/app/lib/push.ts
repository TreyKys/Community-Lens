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
// then set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT (a mailto:
// for your own domain — push services use it to reach you if you start
// flooding them).
//
// NOT named NEXT_PUBLIC_*, even though the public key genuinely is public and
// the browser genuinely does need it. In this deployment NEXT_PUBLIC_ vars are
// baked into the Docker image at build time from GitHub secrets, so that name
// would make switching push on a rebuild-and-redeploy instead of three lines
// in the server's .env. Nothing client-side reads it directly — the browser
// gets the key from GET /api/push/subscribe — so it can stay a plain runtime
// variable and be turned on with a restart.

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@opinionsng.com';

// Why push is off, in words, when it is off.
//
// The first version of this ran setVapidDetails() at module scope guarded only
// by "are both strings non-empty". web-push VALIDATES the key shapes and
// throws, so a pair that is present but wrong — the commonest mistake being
// the public and private values entered the wrong way round, since one is 87
// characters and the other 43 and both are opaque base64 — took down every
// route that imports this file with an unexplained 500. The operator sees a
// broken endpoint and no hint that the cause is two values in the wrong order.
//
// A misconfiguration must be REPORTED, never thrown. Push staying off is a
// degraded feature; a module that throws on import is an outage.

function describe(): string | null {
  if (!PUBLIC_KEY && !PRIVATE_KEY) return 'VAPID keys not configured';
  if (!PUBLIC_KEY) return 'VAPID_PUBLIC_KEY is not set';
  if (!PRIVATE_KEY) return 'VAPID_PRIVATE_KEY is not set';

  // Lengths are the giveaway and are safe to report: a P-256 public key is 65
  // bytes (87 base64url chars) and a private key is 32 bytes (43 chars).
  const swapped = PUBLIC_KEY.length === 43 && PRIVATE_KEY.length === 87;
  if (swapped) {
    return 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are the wrong way round '
      + '(public should be 87 characters and start with B, private 43) — swap them in .env';
  }
  if (PUBLIC_KEY.length !== 87) {
    return `VAPID_PUBLIC_KEY is ${PUBLIC_KEY.length} characters, expected 87`;
  }
  if (PRIVATE_KEY.length !== 43) {
    return `VAPID_PRIVATE_KEY is ${PRIVATE_KEY.length} characters, expected 43`;
  }

  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    return null;
  } catch (e: any) {
    // Its own message names the specific problem and contains no key material.
    return `VAPID keys rejected: ${String(e?.message || e).slice(0, 160)}`;
  }
}

/** Null when push is usable; otherwise a sentence naming what to fix. */
export const pushConfigError: string | null = describe();
export const pushConfigured = pushConfigError === null;

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
