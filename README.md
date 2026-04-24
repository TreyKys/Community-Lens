# Odds.ng

Nigeria's cryptographically transparent event-derivative market.
Built on Next.js + Supabase hot path, Polygon cold vault.

## Monorepo Structure

*   `packages/app`: Next.js 14 frontend + API routes (the primary app).
*   `packages/contract`: Hardhat project for the on-chain Merkle-commit vault.
*   `packages/bot`: Legacy on-chain automation scripts (superseded by cron routes).

## Automation — GitHub Actions

All recurring jobs hit authenticated Next.js API routes. Inngest is scaffolded
but not wired to the managed platform; GitHub Actions is the live automation layer.

| Workflow | Schedule | Hits |
| :--- | :--- | :--- |
| `cron-market-lock.yml` | every 5 min | `POST /api/markets/lock-all` |
| `cron-oracle-resolve.yml` | every 5 min | `POST /api/markets/resolve-due` |
| `cron-daily-seed.yml` | 10:00 UTC daily | `POST /api/markets/seed-daily` |
| `cron-heartbeat.yml` | Sun 00:00 UTC | `POST /api/admin/heartbeat` |

### Required GitHub Secrets

| Secret | Description |
| :--- | :--- |
| `API_BASE_URL` | Your production URL, e.g. `https://odds.ng` |
| `CRON_SECRET` | Shared secret used by the `x-cron-secret` header |

### Required server env vars

These live on the deployed app (Netlify/Vercel/etc.):

| Env | Purpose |
| :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Supabase keys |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role, server only |
| `CRON_SECRET` | Same value as the GitHub secret above |
| `ADMIN_SECRET` | Used by admin API routes |
| `NEXT_PUBLIC_APP_URL` | Base URL the app calls itself on |
| `FOOTBALL_DATA_API_KEY` | football-data.org |
| `API_SPORTS_KEY` | RapidAPI — Basketball/Tennis |
| `PANDASCORE_API_KEY` | PandaScore — eSports |
| `GEMINI_API_KEY` | AI Market Maker |
| `PAYSTACK_SECRET_KEY` | Paystack gateway |
| `NEXT_PUBLIC_WALLET_CONNECT_ID` | RainbowKit fallback |
| `NEXT_PUBLIC_ALCHEMY_KEY` | Polygon RPC |

## Development

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Start local frontend:
    ```bash
    npm run dev -w packages/app
    ```
