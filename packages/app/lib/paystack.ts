/**
 * lib/paystack.ts
 * Paystack Transfer API utilities for real NGN withdrawals.
 *
 * Flow:
 *   1. createTransferRecipient — register the user's bank account
 *   2. initiateTransfer — send NGN to their account
 *   3. Paystack fires a webhook to /api/webhooks/paystack on transfer.success
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

async function paystackRequest(path: string, method: string, body?: any) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY not configured');

  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!data.status) {
    throw new Error(data.message || `Paystack error on ${path}`);
  }

  return data.data;
}

/**
 * Create a transfer recipient (a registered Nigerian bank account).
 * Returns recipient_code — store this to avoid re-creating on future withdrawals.
 */
export async function createTransferRecipient(params: {
  name: string;
  accountNumber: string;
  bankCode: string;
}): Promise<string> {
  const data = await paystackRequest('/transferrecipient', 'POST', {
    type: 'nuban',
    name: params.name,
    account_number: params.accountNumber,
    bank_code: params.bankCode,
    currency: 'NGN',
  });

  return data.recipient_code;
}

/**
 * Initiate a Naira transfer to a recipient.
 * amount is in NGN (NOT kobo — we convert internally).
 * Returns transfer_code for tracking.
 */
export async function initiateTransfer(params: {
  recipientCode: string;
  amountNGN: number;
  reference: string;
  reason?: string;
}): Promise<{ transferCode: string; status: string }> {
  const data = await paystackRequest('/transfer', 'POST', {
    source: 'balance',
    amount: Math.round(params.amountNGN * 100), // convert to kobo
    recipient: params.recipientCode,
    reason: params.reason || 'Odds.ng withdrawal',
    reference: params.reference,
  });

  return {
    transferCode: data.transfer_code,
    status: data.status,
  };
}

/**
 * Verify a transfer status by transfer code.
 */
export async function verifyTransfer(transferCode: string): Promise<string> {
  const data = await paystackRequest(`/transfer/${transferCode}`, 'GET');
  return data.status;
}

/**
 * Resolve a bank account number to get the account name.
 * Useful for confirming account details before withdrawal.
 */
export async function resolveAccountNumber(params: {
  accountNumber: string;
  bankCode: string;
}): Promise<string> {
  const data = await paystackRequest(
    `/bank/resolve?account_number=${params.accountNumber}&bank_code=${params.bankCode}`,
    'GET'
  );
  return data.account_name;
}

/**
 * List available Nigerian banks with their codes.
 * Cache this client-side — it rarely changes.
 */
export async function listBanks(): Promise<{ name: string; code: string }[]> {
  const data = await paystackRequest('/bank?country=nigeria&perPage=100', 'GET');
  return (data || []).map((b: any) => ({ name: b.name, code: b.code }));
}
