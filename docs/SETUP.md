# Odds.ng — deployment setup

This is the operator's checklist for getting Odds.ng running in production. It
covers every secret/env var, what each piece does, and how to wire the GitHub
Actions cron jobs.

## 1. Runtime environment variables

These must be set on whatever hosts the Next.js app (Vercel, Netlify, your own
box). They're consumed by the API routes at request time.

### Supabase (database + auth)

| Var | Where it's used | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Project URL from Supabase dashboard. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | Public anon key — safe to ship. |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS. Never set as `NEXT_PUBLIC_*`. |

### Paystack (card deposits + bank withdrawals)

| Var | Notes |
| --- | --- |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | Public key (`pk_test_…` or `pk_live_…`). |
| `PAYSTACK_SECRET_KEY` | Server-only secret. Used to verify webhook signatures and call the Transfer API. |

Configure the Paystack webhook URL to `https://<your-domain>/api/webhooks/paystack`.

### Squad by HabariPay (per-user virtual NUBAN deposits)

| Var | Notes |
| --- | --- |
| `SQUAD_SECRET_KEY` | Server-only. Used to provision virtual accounts and verify webhook signatures (HMAC-SHA512). |
| `SQUAD_PUBLIC_KEY` | Optional — only if a future client-side flow needs it. |
| `SQUAD_BASE_URL` | Optional. Defaults to `https://sandbox-api-d.squadco.com`. Set to the live URL once production keys are issued. |

Configure the Squad webhook URL to `https://<your-domain>/api/webhooks/squad`. The
header Squad sends is `x-squad-encrypted-body` containing the HMAC-SHA512 hex
digest of the raw body, keyed by `SQUAD_SECRET_KEY`.

### Sports & eSports data providers

| Var | Used by |
| --- | --- |
| `FOOTBALL_DATA_API_KEY` | football-data.org — fixtures + results |
| `API_SPORTS_KEY` | api-sports / RapidAPI — basketball + tennis fixtures |
| `PANDASCORE_API_KEY` | pandascore.co — eSports fixtures + winners |

### Admin + cron

| Var | Notes |
| --- | --- |
| `ADMIN_SECRET` | Server-only. Validates the admin login form and admin Bearer tokens. The admin shell exchanges this for an httpOnly cookie via `/api/admin/auth`. **Do not** set as `NEXT_PUBLIC_*`. |
| `CRON_SECRET` | Server-only. Sent as `x-cron-secret` from GitHub Actions and the in-app heartbeat trigger. |
| `NEXT_PUBLIC_CRON_SECRET` | Only needed if you want the admin's "Fire heartbeat" button to work in the browser. Future work: move that call server-side too. |
| `NEXT_PUBLIC_APP_URL` | Used by the daily seeder when calling its own internal admin endpoint. Set to your deployed URL. |

### Wallets / on-chain

| Var | Notes |
| --- | --- |
| `KMS_KEY_ID` | AWS KMS key used to derive deterministic per-user addresses. |
| `KMS_ACCESS_KEY_ID`, `KMS_SECRET_ACCESS_KEY`, `KMS_REGION` | AWS credentials with `kms:GenerateMac` on the key above. |

## 2. GitHub Actions

Four cron workflows live under `.github/workflows/`:

| Workflow | Schedule | Endpoint hit | Purpose |
| --- | --- | --- | --- |
| `cron-daily-seed.yml` | `0 10 * * *` (10 UTC daily) | `POST /api/markets/seed-daily` | Pulls upcoming fixtures from football-data, api-sports (basketball), and PandaScore (eSports), then creates one parent market per game plus BTTS/OU sub-markets for football. |
| `cron-market-lock.yml` | `*/5 * * * *` | `POST /api/markets/lock-all` | Locks any market whose `closes_at` has passed. Computes the bet-book Merkle root. |
| `cron-oracle-resolve.yml` | `*/5 * * * *` | `POST /api/markets/resolve-due` | Looks up the official result for each locked market via the sport API and pays out winners. |
| `cron-heartbeat.yml` | `0 0 * * 0` (Sunday midnight UTC) | `POST /api/admin/heartbeat` | Resets the on-chain escape-hatch clock. If this stops firing for 30 days, users can withdraw funds directly on-chain. |

### Required GitHub repository secrets

Set these in **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `API_BASE_URL` | The fully qualified base URL of the deployed app (e.g. `https://odds.ng` or your preview URL). No trailing slash. |
| `CRON_SECRET` | Match the value of `CRON_SECRET` set on the runtime environment. |

That's it for GitHub. Every workflow uses these two and nothing else.

### Manually triggering a workflow

Each workflow has `workflow_dispatch:` enabled, so you can run any of them
on-demand from **Actions → \<workflow name\> → Run workflow** in the GitHub UI.
This is useful for:

- Smoke-testing immediately after configuring secrets.
- Forcing a re-seed if a sport API was rate-limited during the scheduled run.
- Rerunning the heartbeat manually if the Sunday job missed.

### Verifying

After secrets are set, run the heartbeat workflow manually. You should see:

1. ✅ green check on the workflow run.
2. A new row in the `heartbeat_log` table in Supabase.
3. The "Escape Hatch Clock" tile on the admin Treasury tab showing today's date.

If the workflow fails with `401 Unauthorized`, the `CRON_SECRET` GitHub secret
doesn't match the runtime env var. If it fails with a connection error, check
`API_BASE_URL`.

## 3. Database migrations

Apply the SQL files under `supabase/migrations/` in filename order. The most
recent additions:

- `20240508000000_squad_integration.sql` — Squad virtual accounts + transactions.
- `20240509000000_merge_free_bet_credits.sql` — folds `free_bet_credits` into `bonus_balance`.

If you're using the Supabase CLI: `supabase db push`. Otherwise paste the
files into the SQL editor in order.

## 4. Sanity checklist before going live

- [ ] Every var in §1 is set on the runtime environment.
- [ ] `NEXT_PUBLIC_ADMIN_SECRET` is **not** set anywhere (it shouldn't exist anymore).
- [ ] Both webhook URLs are registered with Paystack and Squad.
- [ ] All four cron workflows have run at least once successfully.
- [ ] A test deposit through the Squad bank-transfer tab arrives within 30s.
- [ ] A test deposit through the Paystack card flow credits within 30s.
- [ ] Admin login at `/admin` works with `ADMIN_SECRET`; the page bundle in DevTools does **not** contain the secret string.
