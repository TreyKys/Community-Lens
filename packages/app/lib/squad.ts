/**
 * lib/squad.ts
 * Squad by HabariPay client for **Dynamic Virtual Account** deposits.
 *
 * Why dynamic, not static: static (per-user permanent) NUBANs are regulated as
 * bank accounts under CBN rules and require BVN-tier-2 KYC for every user. Dynamic
 * VAs are minted per deposit, hold no balance, and need no BVN — same UX (transfer
 * from any Nigerian bank, credit lands in seconds), much less friction.
 *
 * Inbound webhooks land at /api/webhooks/squad. Signature verification is
 * HMAC-SHA512 of the raw body, keyed by SQUAD_SECRET_KEY.
 *
 * NOTE: Squad treats dynamic VAs as a restricted service. Email
 * help@squadco.com or growth@habaripay.com to request access on your account
 * before this will work in production.
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

export type DynamicVirtualAccount = {
  virtual_account_number: string;
  account_name?: string;
  bank?: string;
  bank_code?: string;
  customer_identifier?: string;
  amount?: number | string;
  reference?: string;
};

/**
 * Create a one-shot Dynamic Virtual Account for a single deposit.
 *
 * @param amountKobo amount in kobo (multiply naira by 100)
 * @param durationSeconds time before the NUBAN expires (default 1800 = 30 min)
 */
export async function createDynamicVirtualAccount(params: {
  firstName: string;
  lastName: string;
  email: string;
  amountKobo: number;
  durationSeconds?: number;
  transactionRef: string;
}): Promise<DynamicVirtualAccount> {
  const customerName = `${params.firstName} ${params.lastName}`.trim() || 'Odds Punter';
  return await squadRequest('/virtual-account/create-dynamic-virtual-account', 'POST', {
    customer_name: customerName,
    email: params.email,
    amount: params.amountKobo,
    currency_code: 'NGN',
    duration: params.durationSeconds ?? 1800,
    transaction_ref: params.transactionRef,
  });
}

export type CheckoutSession = {
  checkout_url: string;
  transaction_ref: string;
};

/**
 * Initiate a Squad-hosted checkout for card / bank / USSD payments.
 * Returns a checkout_url to redirect the user to. The webhook at
 * /api/webhooks/squad reconciles the credit by transaction_ref.
 */
export async function initiateCheckout(params: {
  amountKobo: number;
  email: string;
  transactionRef: string;
  callbackUrl: string;
  customerName?: string;
  metadata?: Record<string, any>;
}): Promise<CheckoutSession> {
  return await squadRequest('/transaction/initiate', 'POST', {
    amount: params.amountKobo,
    email: params.email,
    currency: 'NGN',
    initiate_type: 'inline',
    transaction_ref: params.transactionRef,
    callback_url: params.callbackUrl,
    payment_channels: ['card', 'ussd', 'bank', 'transfer'],
    customer_name: params.customerName,
    metadata: params.metadata || {},
  });
}

/**
 * Backstop verification by reference. Webhooks are the primary credit path; this
 * is for the WalletModal poller / manual reconciliation.
 */
export async function verifyTransaction(reference: string): Promise<any> {
  return await squadRequest(`/transaction/verify/${encodeURIComponent(reference)}`, 'GET');
}
