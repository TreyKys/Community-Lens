/**
 * lib/ops-email.ts
 * Fire-and-forget email alerts to the ops inbox (Resend).
 *
 * Used to ping the operator when a new withdrawal lands so they can review
 * + send the manual bank transfer. Silently no-ops if RESEND_API_KEY is
 * missing — never block or fail the user-facing path on email delivery.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Opinions.ng <ops@notifications.opinions.ng>';
const DEFAULT_TO = 'hello@neurodevlabs.cloud';

export interface OpsEmail {
  subject: string;
  html: string;
}

export async function sendOpsEmail({ subject, html }: OpsEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // silent no-op until configured

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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[ops-email] Resend rejected:', res.status, body);
    }
  } catch (err: any) {
    console.error('[ops-email] send failed:', err?.message || err);
  }
}

export function formatNaira(n: number | string): string {
  const num = Number(n) || 0;
  return `₦${num.toLocaleString('en-NG')}`;
}
