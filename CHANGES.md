# TruthMarket — Phase 3 Changes

## What changed and why

### AuthModal.tsx
- Removed phone OTP (no SMS provider configured yet — coming via Termii in Phase 3)
- Fixed email OTP to send a 6-digit code instead of a magic link
- Added `shouldCreateUser: true` so new signups work
- Added `inputMode="numeric"` and auto-strip non-digits for cleaner UX
- Added `autoComplete="one-time-code"` for iOS autofill support

### Navbar.tsx
- Fixed balance lookup to use `id` column (not `walletAddress`)

### WalletModal.tsx
- Completely rewritten — no more on-chain mint from frontend
- Deposit tab shows fee breakdown (Paystack fee + tNGN to receive)
- Withdraw tab collects bank code + account number, calls `/api/withdraw`
- Large withdrawal (≥₦500,000) shows "under review" message to user
- RainbowKit fallback hidden in footer link — not in onboarding flow

### lib/supabase.ts
- Removed hardcoded fallback credentials (security risk)
- Now throws a clear error if env vars are missing

### NEW: /api/bet
- Standard POST route — 50ms response, no blockchain
- Validates balance, checks market is open, deducts Entry Rake (1.5%)
- Writes bet to user_bets table
- Detects jackpot eligibility (≥₦500 stake)
- Uses real balance first, bonus balance second
- Bonus balance cannot be withdrawn

### NEW: /api/withdraw
- Applies 1.5% conversion spread + ₦100 flat fee
- Routes withdrawals ≥₦500,000 to pending_admin_approval
- Deducts balance immediately on request
- Paystack Transfer API wired up (TODO comments mark where keys go)

### NEW: /api/markets/lock
- Fires exactly once per market at closes_at time
- Computes SHA-256 Merkle root of all bets
- Stores root in merkle_commits table
- Marks market as "locked" — no more bets accepted
- TODO comment marks where Polygon KMS signing goes (Phase 3)

### NEW: /api/markets/resolve
- Called by oracle bot after result confirmed
- Calculates winning/losing pools
- Applies 5% Resolution Rake on losing pool
- Distributes payouts proportionally to all winners
- Handles void cases (everyone on same side)

### NEW: /api/admin/heartbeat
- Called weekly by Inngest job
- Logs heartbeat to Supabase
- TODO comment marks where on-chain heartbeat() tx goes

### NEW: /api/admin/withdrawals
- GET: list pending large withdrawals for TreyKy to review
- POST: approve (queues for Paystack) or reject (refunds balance)

### NEW: /api/webhooks/paystack (rewritten)
- No longer mints tNGN to individual wallets
- No longer uses raw PRIVATE_KEY env var
- Credits tNGN balance directly in Supabase (off-chain)
- Applies 1.5% conversion spread on deposit
- Uses userId from Paystack metadata (not walletAddress)
- Full idempotency check with paystack_transactions table

### TruthMarket.sol (rewritten)
- Vault pattern — no individual user escrow
- createMarket + createMarketBatch preserved for non-sports markets
- NEW: commitBetState() — stores Merkle root at lock time
- NEW: heartbeat() — resets 30-day emergency clock
- NEW: emergencyWithdraw() — users reclaim funds if backend goes silent
- NEW: updateEscrowBalance() — backend registers user balances on-chain
- NEW: emergencyUnlocksIn() — public view function showing time remaining
- resolveMarket() simplified — distribution handled by backend

### supabase/migrations/20240503000000_phase3_schema.sql (NEW)
- Drops old walletAddress-primary-key users table
- New users table: id = Supabase auth UUID
- New columns: tngn_balance, bonus_balance, wallet_address
- New tables: user_bets, merkle_commits, paystack_transactions,
              withdrawals, treasury_log, heartbeat_log, error_log
- RLS policies on all user-facing tables
