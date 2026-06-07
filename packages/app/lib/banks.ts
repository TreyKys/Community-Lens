/**
 * lib/banks.ts
 *
 * Curated list of Nigerian banks Squad can payout to, with their NIP bank codes.
 * This is the "approved banks" allowlist for withdrawals — keeps the dropdown
 * short and avoids users picking obscure/unsupported institutions that bounce
 * at the gateway. Includes major commercial banks + the popular neobanks/MFBs
 * Nigerian users actually hold accounts with.
 *
 * Source: NIBSS NIP bank code registry (codes are stable, rarely change).
 */

export interface ApprovedBank {
  name: string;
  code: string;
}

export const APPROVED_BANKS: ApprovedBank[] = [
  { name: 'Access Bank', code: '044' },
  { name: 'Citibank Nigeria', code: '023' },
  { name: 'Ecobank Nigeria', code: '050' },
  { name: 'Fidelity Bank', code: '070' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'First City Monument Bank (FCMB)', code: '214' },
  { name: 'Globus Bank', code: '00103' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
  { name: 'Heritage Bank', code: '030' },
  { name: 'Keystone Bank', code: '082' },
  { name: 'Kuda Microfinance Bank', code: '50211' },
  { name: 'Moniepoint MFB', code: '50515' },
  { name: 'Opay (Paycom)', code: '999992' },
  { name: 'PalmPay', code: '999991' },
  { name: 'Polaris Bank', code: '076' },
  { name: 'Providus Bank', code: '101' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Standard Chartered Bank', code: '068' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'Union Bank of Nigeria', code: '032' },
  { name: 'United Bank for Africa (UBA)', code: '033' },
  { name: 'Unity Bank', code: '215' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
];

export function findBankByCode(code: string): ApprovedBank | undefined {
  return APPROVED_BANKS.find(b => b.code === code);
}
