-- Manual payout columns for withdrawals.
--
-- Until Squad's /payout/* endpoints are activated on our merchant account,
-- withdrawals are settled by direct bank transfer from the operator's own
-- bank. These columns capture the audit trail so the ledger is airtight:
--   * manual_paid_from: which of OUR banks the transfer came out of
--                       (e.g. "GTBank Opinions Ltd", "UBA personal")
--   * manual_reference: the bank's transaction reference for that transfer
--                       (so reconciliation against bank statements is trivial)
--
-- treasury_movements rows for manual payouts use gateway='manual' and stash
-- both values in the metadata column for a complete cross-reference.

ALTER TABLE public.withdrawals
  ADD COLUMN IF NOT EXISTS manual_paid_from text,
  ADD COLUMN IF NOT EXISTS manual_reference text;
