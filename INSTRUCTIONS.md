# TruthMarket — How to Get This Back Into GitHub

## Step 1 — Get this code onto your machine

You have two options:

### Option A: Download and replace (simplest)
1. Download the zip from this conversation
2. Unzip it somewhere on your machine
3. Copy the changed files into your existing local repo, replacing the old ones

### Option B: Apply as a new branch via git
```bash
# On your machine, inside your existing repo
git checkout -b phase3-architecture

# Delete your old versions of the changed files and copy the new ones in
# Then stage everything:
git add -A
git commit -m "Phase 3: Off-chain bet engine, Merkle commits, new fee model, Vault contract"
git push origin phase3-architecture
```
Then open a PR from `phase3-architecture` into your main branch on GitHub.

---

## Step 2 — Run the Supabase migration

This is the most important step. The new schema is incompatible with the old one.

**WARNING: This drops and rebuilds the users table. All test data will be lost. That's fine — you're on testnet.**

In your Supabase dashboard:
1. Go to **SQL Editor**
2. Copy the entire contents of `supabase/migrations/20240503000000_phase3_schema.sql`
3. Paste and run it

Or using the Supabase CLI:
```bash
supabase db push
```

---

## Step 3 — Set up your environment variables

1. Copy the example file:
```bash
cp packages/app/.env.example packages/app/.env.local
```

2. Fill in these values — the minimum needed to run right now:

```
NEXT_PUBLIC_SUPABASE_URL        → Your Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY   → Your Supabase anon key
SUPABASE_SERVICE_ROLE_KEY       → Your Supabase service role key (⚠️ keep secret)
PAYSTACK_SECRET_KEY             → sk_test_... from Paystack dashboard
CRON_SECRET                     → Any random string (e.g. run: openssl rand -hex 32)
ADMIN_SECRET                    → Any random string (different from CRON_SECRET)
```

**Where to find Supabase keys:**
Supabase Dashboard → Project Settings → API → copy "URL", "anon public", and "service_role"

**Leave blank for now (needed in Phase 3 only):**
- `AWS_KMS_KEY_ID` and AWS credentials (mock wallet addresses used until then)
- `NEXT_PUBLIC_ALCHEMY_KEY` (public Amoy RPC used as fallback)
- `NEXT_PUBLIC_TRUTH_MARKET_ADDRESS` (fill after redeploying the contract)

---

## Step 4 — Fix Supabase Email OTP (the original problem)

This is a dashboard-only change — no code needed.

1. Go to **Supabase Dashboard → Authentication → Providers → Email**
2. Turn **OFF** "Confirm email"
3. Make sure **"Enable Email provider"** is ON
4. Click Save

This makes `signInWithOtp` send a **6-digit code** instead of a magic link.
The localhost redirect issue disappears entirely.

---

## Step 5 — Redeploy the smart contract

The old `TruthMarket.sol` is not compatible with the new architecture.

```bash
cd packages/contract
npx hardhat compile
npx hardhat ignition deploy ignition/modules/TruthMarket.ts --network amoy
```

Copy the deployed address into your `.env.local`:
```
NEXT_PUBLIC_TRUTH_MARKET_ADDRESS=0x...
```

---

## Step 6 — Run the app

```bash
cd packages/app
npm install
npm run dev
```

Open http://localhost:3000. You should be able to:
- Sign in with email OTP (6-digit code, no magic link)
- See your balance in the Navbar
- Open the Cashier modal (deposit/withdraw UI)

---

## What still needs to happen before mainnet (Phase 3 checklist)

These are all marked with `// PHASE 3 TODO` comments in the code:

| Item | File | What to do |
|------|------|-----------|
| AWS KMS key derivation | `/api/auth/verify-otp/route.ts` | Replace mock wallet address with real KMS HMAC derivation |
| Paystack deposit checkout | `WalletModal.tsx` | Wire up `PaystackPop.setup()` with live keys |
| Paystack Transfer API (withdrawals) | `/api/withdraw/route.ts` | Uncomment the transfer code, add live keys |
| Polygon Merkle commit | `/api/markets/lock/route.ts` | Sign and publish `commitBetState()` via KMS admin wallet |
| On-chain heartbeat | `/api/admin/heartbeat/route.ts` | Sign and publish `heartbeat()` weekly via Inngest |
| Admin notification | `/api/withdraw/route.ts` | Add Resend/Novu alert to TreyKy when large withdrawal fires |
| Inngest cron jobs | New file needed | Wire up market lock trigger at `closes_at` per market |
| Paystack webhook URL | Paystack Dashboard | Set to your production URL: `https://yourdomain.com/api/webhooks/paystack` |

---

## File map — what changed vs what's new

```
CHANGED:
  packages/app/components/AuthModal.tsx         ← Fixed OTP flow
  packages/app/components/Navbar.tsx            ← Fixed balance lookup
  packages/app/components/WalletModal.tsx       ← New deposit/withdraw UI
  packages/app/lib/supabase.ts                  ← Removed hardcoded keys
  packages/app/app/api/webhooks/paystack/route.ts  ← Off-chain model
  packages/app/app/api/auth/verify-otp/route.ts    ← Service role + correct columns
  packages/contract/contracts/TruthMarket.sol   ← Vault pattern rewrite

NEW:
  packages/app/app/api/bet/route.ts             ← The core bet engine
  packages/app/app/api/withdraw/route.ts        ← Withdrawal with fees
  packages/app/app/api/markets/lock/route.ts    ← Merkle commit at lock
  packages/app/app/api/markets/resolve/route.ts ← Payout distribution
  packages/app/app/api/admin/heartbeat/route.ts ← Escape hatch heartbeat
  packages/app/app/api/admin/withdrawals/route.ts  ← Admin approve/reject
  packages/app/.env.example                     ← All env vars documented
  supabase/migrations/20240503000000_phase3_schema.sql  ← New schema
  CHANGES.md                                    ← Full change log
  INSTRUCTIONS.md                               ← This file
```
