/**
 * lib/ops-email.ts
 * Fire-and-forget email alerts to the ops inbox (Resend).
 *
 * Used to ping the operator when a new withdrawal lands so they can review
 * + send the manual bank transfer. Silently no-ops if RESEND_API_KEY is
 * missing — never block or fail the user-facing path on email delivery.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
// Resend's shared, pre-verified onboarding domain. Works on every account
// without DNS setup — perfect for day-one launch. Set RESEND_FROM in env
// later once you've verified your own domain (e.g. opinions.ng) on
// Resend, and emails will come from "Opinions.ng <ops@yourdomain>".
const DEFAULT_FROM = 'Opinions.ng <onboarding@resend.dev>';
const DEFAULT_TO = 'hello@neurodevlabs.cloud';

export interface OpsEmail {
  subject: string;
  html: string;
}

export async function sendOpsEmail({ subject, html }: OpsEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[ops-email] RESEND_API_KEY not set — skipping email send');
    return;
  }

  const from = process.env.RESEND_FROM || DEFAULT_FROM;
  const to = process.env.OPS_EMAIL || DEFAULT_TO;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const responseBody = await res.text().catch(() => '');
    if (!res.ok) {
      console.error(`[ops-email] Resend rejected ${res.status} — from=${from} to=${to} body=${responseBody.slice(0, 500)}`);
    } else {
      console.log(`[ops-email] sent → ${to} (subject: "${subject.slice(0, 60)}")`);
    }
  } catch (err: any) {
    console.error('[ops-email] send failed:', err?.message || err);
  }
}

export function formatNaira(n: number | string): string {
  const num = Number(n) || 0;
  return `₦${num.toLocaleString('en-NG')}`;
}
