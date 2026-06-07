/**
 * lib/termii.ts
 * Termii client for SMS OTP (phone-based sign-in).
 *
 * Termii owns OTP generation, delivery, expiry and verification — we never
 * store or compare codes ourselves. A successful verify just hands back a
 * `verified: true/false` for the `pinId` we were given at send time.
 *
 * Sender ID must be a pre-approved alphanumeric name (NCC-regulated in
 * Nigeria — register it in the Termii dashboard, approval can take days).
 */

const BASE = 'https://api.ng.termii.com/api';

async function termiiRequest(path: string, body: Record<string, any>) {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) throw new Error('TERMII_API_KEY not configured');

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, api_key: apiKey }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Termii error ${res.status} on ${path}`);
  }
  return data;
}

/** Normalize Nigerian phone input (080..., 234..., +234...) to E.164 (+234XXXXXXXXXX). */
export function normalizeNigerianPhone(input: string): string | null {
  const digits = String(input).replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('0')) return `+234${digits.slice(1)}`;
  if (digits.length === 13 && digits.startsWith('234')) return `+${digits}`;
  if (digits.length === 14 && digits.startsWith('234')) return null; // malformed
  if (digits.length === 10) return `+234${digits}`;
  return null;
}

export type OtpSendResult = { pinId: string; to: string };

export async function sendOtp(phoneE164: string): Promise<OtpSendResult> {
  const senderId = process.env.TERMII_SENDER_ID;
  if (!senderId) throw new Error('TERMII_SENDER_ID not configured');

  const data = await termiiRequest('/sms/otp/send', {
    message_type: 'NUMERIC',
    to: phoneE164.replace(/^\+/, ''),
    from: senderId,
    channel: 'generic',
    pin_attempts: 3,
    pin_time_to_live: 10,
    pin_length: 6,
    pin_placeholder: '< 1234 >',
    message_text: 'Your Opinions.ng verification code is < 1234 >. It expires in 10 minutes.',
  });

  if (!data.pinId) throw new Error(data.message || 'Could not send verification code');
  return { pinId: data.pinId, to: data.to };
}

export async function verifyOtp(pinId: string, pin: string): Promise<boolean> {
  const data = await termiiRequest('/sms/otp/verify', { pin_id: pinId, pin });
  return data.verified === true || data.verified === 'True' || data.verified === 'true';
}
