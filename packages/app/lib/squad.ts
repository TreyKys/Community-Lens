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

/**
 * Look up a Nigerian bank account name from NUBAN + bank code (Squad's
 * name-enquiry endpoint). Used by admin treasury dashboard before approving
 * a payout to confirm the destination is correct.
 */
export async function resolveBankAccount(params: {
  bankCode: string;
  accountNumber: string;
}): Promise<{ accountName: string; bankCode: string; accountNumber: string }> {
  const data = await squadRequest('/payout/account/lookup', 'POST', {
    bank_code: params.bankCode,
    account_number: params.accountNumber,
  });
  return {
    accountName: data?.account_name ?? data?.accountName ?? '',
    bankCode: params.bankCode,
    accountNumber: params.accountNumber,
  };
}

/**
 * Initiate a payout to a Nigerian bank via Squad. Mirrors Paystack's
 * createTransferRecipient + initiateTransfer rolled into one call.
 *
 * @param amountKobo amount in kobo (multiply naira by 100)
 * @returns transaction_reference for tracking; webhook fires with this on completion
 */
export async function initiateTransfer(params: {
  amountKobo: number;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  transactionRef: string;
  remark?: string;
}): Promise<{ transactionRef: string; status: string; merchantRef?: string }> {
  const data = await squadRequest('/payout/transfer', 'POST', {
    transaction_reference: params.transactionRef,
    amount: params.amountKobo,
    bank_code: params.bankCode,
    account_number: params.accountNumber,
    account_name: params.accountName,
    currency_id: 'NGN',
    remark: params.remark || `Odds.ng payout ${params.transactionRef}`,
  });
  return {
    transactionRef: data?.transaction_reference || params.transactionRef,
    status: data?.transaction_status || data?.status || 'pending',
    merchantRef: data?.merchant_amount,
  };
}

/**
 * Look up the current Squad merchant balance (NGN, in kobo).
 * Used by the treasury dashboard to show live "available to pay out".
 */
export async function getMerchantBalance(): Promise<{ availableKobo: number; ledgerKobo: number }> {
  const data = await squadRequest('/merchant/balance', 'GET');
  return {
    availableKobo: Number(data?.available_balance ?? 0),
    ledgerKobo: Number(data?.ledger_balance ?? 0),
  };
}
