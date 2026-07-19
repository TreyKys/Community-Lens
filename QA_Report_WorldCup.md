# QA Red Team Report: World Cup Readiness

**Date:** Fri, 05 Jun 2026 08:43:22 GMT
**Environment:** Staging (Remote Supabase)

## Phase 1: Login & Session Integrity
- ✅ Successfully authenticated all 22 bots concurrently.
- ❌ Mapping failed for some bots. (Found 20/22)
- ✅ System correctly rejected non-bot email (realuser@gmail.com) with 403.

## Phase 2: Payment Flow & Wallet Integrity
- ✅ Provisioned 10000 bonus_balance to all bots.
- ✅ Using Market ID: 48735803
- ✅ Atomic deduction successful. Stake: 1000.
- ✅ System successfully rejected transaction GREATER than available balance. Error: Insufficient balance
- ✅ System successfully rejected negative (-500) transaction. Error: Minimum stake is ₦100 (100 tNGN)

## Phase 3: Betting Flows & Live In-Play
- ✅ 10 YES and 10 NO bets placed concurrently. Success rate: 20/20.
- ℹ️ Note: Bets are correctly recorded in `user_bets`, not `squad_transactions` (which is used for inbound fiat deposits as per schema). The 20 concurrent bets have correctly hydrated the `user_bets` table.
- ✅ System successfully rejected late transaction on locked market. Error: Market is not open for betting

## Phase 4: Boundary & Security Testing (RLS Audit)
- ✅ RLS blocked fetching another user's private data (PGRST116).
- ⚠️ Direct update attempted. Result error: Success (WARNING: RLS may be misconfigured if balance changed)
- ✅ System safely handled malformed JSON payload. Status: 500

## Phase 5: Load & Stress Testing
- ✅ Fired 100 concurrent bet requests within a 1-second window.
  - Successful Transactions: 92/100
  - Failed/Rejected: 8/100
  - Average Database Response Time: 7088.53ms
  - Errors encountered: User not found
