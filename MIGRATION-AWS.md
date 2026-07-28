# Netlify → AWS migration runbook

Self-hosting the Next.js app on a single small AWS instance behind Caddy.
Written for a **days-of-runway** cutover with **real user funds in play**.

**Supabase does not move.** The database, auth, and every naira of user balance
stay exactly where they are. This migration only changes who serves HTTP. That
is what makes it low-risk — and it means "restore the site" is the only recovery
you ever need, never "restore the data".

---

## 0. Do this TODAY, before anything else

**Export every environment variable out of Netlify** (Site settings →
Environment variables) into `.env.production` on your machine.

Once the account lapses you may lose the only copy of `SQUAD_SECRET_KEY`,
`CRON_SECRET`, `ADMIN_SECRET`, and the sports-data API keys. Some are not
recoverable — you'd have to re-issue them with the provider. **This is the one
irreversible step if you get it wrong.**

```bash
cp .env.production.example .env.production
# fill it in from Netlify, then:
chmod 600 .env.production
```

---

## 1. What is actually coupled to Netlify

Almost nothing — verified against the repo:

| Concern | Status |
|---|---|
| `netlify.toml` | Does not exist |
| `next.config.mjs` | Vanilla Next.js, no adapter |
| All 7 cron jobs | **GitHub Actions**, not Netlify — they curl `secrets.API_BASE_URL` |
| Supabase | Separate service, untouched |
| Deploy webhook | Was `NETLIFY_DEPLOY_SECRET`; now generic `DEPLOY_SECRET` (legacy still accepted) |

So the cutover is: run the container somewhere, repoint DNS, change **one
GitHub secret**, update **one Squad webhook URL**.

---

## 2. Provision (~20 min)

**Lightsail 2GB ($10/mo flat, 3TB transfer included)** — recommended for cost
predictability. EC2 `t4g.small` works identically if you want room to grow.

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker

# Attach a static IP (Lightsail: Networking → Attach static IP).
# A dynamic IP that changes on reboot will silently break DNS and TLS.

git clone <your-repo> ~/app && cd ~/app
cp .env.production.example .env.production   # paste values from step 0
chmod 600 .env.production
```

Edit `Caddyfile` → replace `opinions.ng` with your real domain.

**Firewall:** allow only 80, 443, and SSH (ideally SSH restricted to your IP).
Port 3000 is never published to the host — Caddy reaches the app over the
internal Docker network, so there is no way to bypass TLS.

---

## 3. Stage and test BEFORE touching DNS

Point a throwaway subdomain (`staging.opinions.ng`) at the instance, put it in
the `Caddyfile`, and bring the stack up:

```bash
docker compose up -d --build
docker compose logs -f app
```

Test against the **real** Supabase (it's the same database, so this is a true
rehearsal):

- [ ] Site loads over HTTPS, valid certificate
- [ ] Login works
- [ ] `/api/status` returns 200
- [ ] **A small REAL deposit (₦500) credits end-to-end**
- [ ] Place a bet; balance deducts correctly
- [ ] `/admin` loads and authenticates
- [ ] Each cron endpoint answers by hand:
      `curl -X POST https://staging.../api/squad/reconcile -H "x-cron-secret: $CRON_SECRET"`

Do **not** proceed until the deposit test passes. It exercises Squad → webhook →
settle → wallet, which is the riskiest path in the whole system.

---

## 4. Cutover (the ordered part — sequence matters)

Do this in a window with **no matches locking or resolving** (check the markets
table) and ideally low traffic.

1. **T-24h — lower DNS TTL to 60s.** Without this, propagation can take hours
   and you cannot roll back quickly.
2. **T-0 — put the real domain in `Caddyfile`**, `docker compose up -d caddy`,
   confirm the certificate issues.
3. **Flip DNS** (A record → instance static IP).
   > Both Netlify and AWS now serve for a few minutes. **This is safe**: both hit
   > the same Supabase, and every money path is idempotent (`settle_squad_deposit`
   > is ledger-anchored, `request_withdrawal` is row-locked, slip settlement
   > no-ops on re-settle). Double-serving cannot double-credit.
4. **Update `NEXT_PUBLIC_APP_URL`** in `.env.production` → rebuild (it's inlined
   into the client bundle at build time, so a rebuild is required, not a restart).
   Squad's card checkout derives its callback URL from this — stale value means
   users land on a dead host after paying.
5. **Update the Squad dashboard webhook** → `https://<new-domain>/api/webhooks/squad`.
6. **Update the GitHub secret `API_BASE_URL`** → `https://<new-domain>`.
   This repoints all 7 crons at once.
7. **Watch one full 5-minute cron cycle** in the Actions tab. `cron-market-lock`,
   `cron-oracle-resolve`, and `cron-squad-reconcile` must all go green.
8. **Only now cancel Netlify.**

---

## 5. Money-safety gates

The three things an outage actually costs you, in priority order:

| Risk | Why it hurts | Mitigation |
|---|---|---|
| **`cron-market-lock` stops** | Markets don't lock at kickoff → users can bet on **matches already in progress**, with known outcomes. Directly exploitable. | Cut over in a no-match window. Verify this cron first after DNS. |
| **`cron-squad-reconcile` stops** | Deposits made during downtime don't credit. **Hard cliff: the sweep only looks back `MAX_AGE_DAYS = 3`.** Past 3 days they are permanently stranded. | Keep total downtime well under 3 days. Repair stragglers via `/admin/deposits`. |
| **`cron-oracle-resolve` stops** | Markets don't resolve; winners unpaid. Self-heals on return, but users see frozen bets. | Run it manually right after cutover. |

**If you are forced dark before AWS is ready:**
1. Stop accepting new deposits first (disable the deposit button) — this prevents
   money entering limbo, which is the only genuinely unrecoverable failure.
2. Maintenance page.
3. Restore service **inside 3 days**.
4. On return: run `/api/squad/reconcile` manually, then check `/admin/deposits`
   for anything the sweep aged out.

---

## 6. Deploys after cutover

```bash
./scripts/deploy.sh                 # deploys current branch
./scripts/deploy.sh main            # deploys a specific ref
```

Builds the new image while the old container keeps serving, health-checks the
new one, and **rolls back automatically if it fails**. A failed deploy never
leaves you with no site.

---

## 7. Rollback

Because Supabase never moved, rollback is purely DNS:

- **Netlify still active** → point the A record back. Done, seconds.
- **Netlify already gone** → fix forward on the instance:
  `docker compose logs app`, then `./scripts/deploy.sh <last-good-sha>`.

This is the real argument for cutting over *before* cancelling Netlify: it keeps
a working rollback target alive for the one window where you might need it.

---

## 8. After you're settled

- **Backups:** Supabase handles DB backups; confirm your plan's retention. The
  instance itself is disposable — everything stateful is in Supabase and the
  Caddy cert volume.
- **Uptime monitoring:** point any free monitor at `/api/status`. A single
  instance has no auto-healing; you want to hear about a crash from a pager, not
  from a user who can't withdraw.
- **Cost check:** confirm the first month's bill matches expectations before
  assuming the savings are real.
