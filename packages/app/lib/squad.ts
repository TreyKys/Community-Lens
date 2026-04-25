/**
 * lib/squad.ts
 * Squad by HabariPay client for per-user Virtual NUBAN provisioning + verification.
 *
 * Inbound deposits land via webhook on /api/webhooks/squad. Webhook signature
 * verification is HMAC-SHA512 of the raw body, keyed by SQUAD_SECRET_KEY,
 * delivered in the `x-squad-encrypted-body` header.
 */

const DEFAULT_BASE = 'https://sandbox-api-d.squadco.com';

function squadBase() {
  return process.env.SQUAD_BASE_URL || DEFAULT_BASE;
}

async function squadRequest(path: string, method: string, body?: any) {
  const secret = process.env.SQUAD_SECRET_KEY;
  if (!secret) throw new Error('SQUAD_SECRET_KEY not configured');

  const res = await fetch(`${squadBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `Squad error ${res.status} on ${path}`);
  }
  return data.data;
}

export type SquadVirtualAccount = {
  customer_identifier: string;
  virtual_account_number: string;
  account_name: string;
  bank_code?: string;
  bank?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

/**
 * Provision (or fetch) a Virtual NUBAN for a user.
 * customerIdentifier should be a stable per-user string (we use the user UUID).
 */
export async function createVirtualAccount(params: {
  customerIdentifier: string;
  firstName: string;
  lastName: string;
  email: string;
  mobileNum?: string;
  bvn?: string;
}): Promise<SquadVirtualAccount> {
  return await squadRequest('/virtual-account', 'POST', {
    customer_identifier: params.customerIdentifier,
    first_name: params.firstName,
    last_name: params.lastName,
    email: params.email,
    mobile_num: params.mobileNum,
    bvn: params.bvn,
  });
}

/**
 * Verify a Squad transaction by reference. Useful as a backstop for the webhook
 * (call this from the WalletModal poller before crediting if a webhook is delayed).
 */
export async function verifyTransaction(reference: string): Promise<any> {
  return await squadRequest(`/transaction/verify/${encodeURIComponent(reference)}`, 'GET');
}
