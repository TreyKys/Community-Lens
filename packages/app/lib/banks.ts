/**
 * lib/banks.ts
 *
 * Curated list of Nigerian banks Squad can payout to, with their NIBSS NIP
 * 6-digit institution codes. This is the "approved banks" allowlist for
 * withdrawals — keeps the dropdown short and avoids users picking obscure
 * institutions that bounce at the gateway.
 *
 * IMPORTANT: these are NIP codes (6 digits), not the legacy CBN bank codes
 * (3 digits). Squad's /payout/account/lookup + /payout/transfer endpoints
 * validate the identifier as `nip_code` with a strict 6-char length check.
 * Source: NIBSS NIP institution code registry (Nov 2025).
 *
 * Covered: all 28 commercial banks currently licensed + the neobanks/MFBs
 * (Kuda/Opay/PalmPay/Sparkle/FairMoney/VFD/Rubies/Renmoney) + the 4 Payment
 * Service Banks (9PSB, HopePSB, MoMo, SmartCash). Defunct banks (Diamond,
 * Enterprise) and corporate-only / merchant banks are intentionally excluded.
 */

export interface ApprovedBank {
  name: string;
  code: string;
}

export const APPROVED_BANKS: ApprovedBank[] = [
  // ── Commercial banks ───────────────────────────────────────────────────
  { name: 'Access Bank', code: '000014' },
  { name: 'Citibank Nigeria', code: '000009' },
  { name: 'Ecobank Nigeria', code: '000010' },
  { name: 'Fidelity Bank', code: '000007' },
  { name: 'First Bank of Nigeria', code: '000016' },
  { name: 'First City Monument Bank (FCMB)', code: '000003' },
  { name: 'Globus Bank', code: '000027' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '000013' },
  { name: 'Heritage Bank', code: '000020' },
  { name: 'Jaiz Bank', code: '000006' },
  { name: 'Keystone Bank', code: '000002' },
  { name: 'Lotus Bank', code: '000029' },
  { name: 'Optimus Bank', code: '000036' },
  { name: 'Polaris Bank', code: '000008' },
  { name: 'Premium Trust Bank', code: '000031' },
  { name: 'Providus Bank', code: '000023' },
  { name: 'Signature Bank', code: '000034' },
  { name: 'Stanbic IBTC Bank', code: '000012' },
  { name: 'Standard Chartered Bank', code: '000021' },
  { name: 'Sterling Bank', code: '000001' },
  { name: 'Suntrust Bank', code: '000022' },
  { name: 'Taj Bank', code: '000026' },
  { name: 'Titan Trust Bank', code: '000025' },
  { name: 'Union Bank of Nigeria', code: '000018' },
  { name: 'United Bank for Africa (UBA)', code: '000004' },
  { name: 'Unity Bank', code: '000011' },
  { name: 'Wema Bank', code: '000017' },
  { name: 'Zenith Bank', code: '000015' },

  // ── Neobanks / digital wallets ─────────────────────────────────────────
  { name: 'Kuda Microfinance Bank', code: '090267' },
  { name: 'Opay (Paycom)', code: '100004' },
  { name: 'PalmPay', code: '100033' },
  { name: 'Sparkle Microfinance Bank', code: '090325' },
  { name: 'FairMoney Microfinance Bank', code: '090551' },
  { name: 'VFD Microfinance Bank', code: '090110' },
  { name: 'Eyowo', code: '090328' },
  { name: 'Renmoney Microfinance Bank', code: '090198' },

  // ── Payment Service Banks (PSBs) ───────────────────────────────────────
  { name: '9 Payment Service Bank (9PSB)', code: '120001' },
  { name: 'HopePSB', code: '120002' },
  { name: 'MoMo PSB', code: '120003' },
  { name: 'SmartCash PSB', code: '120004' },
];

export function findBankByCode(code: string): ApprovedBank | undefined {
  return APPROVED_BANKS.find(b => b.code === code);
}
