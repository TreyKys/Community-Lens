# Deploys

Production runs a container built by CI. **The server never compiles anything.**

```
push to main → tests → build image → push to GHCR → server pulls → health check
                 ↓ red                                                  ↓ fail
              no deploy                                          auto-rollback
```

Deploy takes ~30 seconds. Building on the box took 8–15 minutes and competed
with live traffic for RAM on a 2 GB instance, so this is both faster and safer.

---

## One-time setup

### 1. GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

**Server access:**

| Secret | Value |
|---|---|
| `SSH_HOST` | `54.229.72.47` |
| `SSH_USER` | `ubuntu` |
| `SSH_PRIVATE_KEY` | Contents of a private key authorised on the server (below) |

**Build-time values** — these are inlined into the client bundle, so CI needs
the same values production uses:

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WALLET_CONNECT_ID`,
`NEXT_PUBLIC_ALCHEMY_KEY`, `NEXT_PUBLIC_ENABLE_PHONE_AUTH`,
`NEXT_PUBLIC_TRUTH_MARKET_ADDRESS`, `NEXT_PUBLIC_PAYMASTER_URL`

Copy each from your server's `.env`. Set any you don't use to an empty string.

> Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `SQUAD_SECRET_KEY`,
> `ADMIN_SECRET`, `CRON_SECRET`, …) are **deliberately not here.** They stay in
> `.env` on the server and are read at runtime, so they never enter an image
> layer or a build log.

### 2. A deploy key for CI → server

On the **server**, make a key pair CI will use:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gha_deploy -N "" -C "github-actions"
cat ~/.ssh/gha_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Print the key as ONE line and paste that into SSH_PRIVATE_KEY:
base64 -w0 ~/.ssh/gha_deploy; echo

rm ~/.ssh/gha_deploy           # GitHub holds it now; no reason to leave a copy
```

**Use the base64 form.** A private key is multi-line, and copying multi-line
text out of a browser-based SSH terminal frequently drops the line breaks.
OpenSSH then reports only `Load key: error in libcrypto` — technically correct,
completely unhelpful. base64 is a single line with nothing to mangle.

The workflow accepts either format (it detects `BEGIN` and falls back to base64
decoding) and validates the key before connecting, so a bad paste fails with a
clear message rather than `Permission denied (publickey)`.

### 3. Let the server pull from GHCR

The package is private, so the server authenticates once. Create a GitHub PAT
(classic) with **only** `read:packages`, then on the server:

```bash
echo "YOUR_PAT" | docker login ghcr.io -u TreyKys --password-stdin
```

This persists in `~/.docker/config.json`; you won't repeat it.

### 4. Point the server at `main`

Production should track the branch that gets reviewed, not a feature branch:

```bash
cd ~/app && git fetch origin main && git checkout main
```

---

## Normal deploy

Merge to `main`. That's it — the workflow runs automatically.

Watch it in the **Actions** tab. If tests fail, nothing deploys.

## Rollback

**Actions → Build & Deploy → Run workflow**, and put a previous commit SHA in
the **image_tag** box. It skips build/test and redeploys that exact image in
~30 seconds.

Find recent tags under repo → **Packages**, or on the server:

```bash
docker images ghcr.io/treykys/community-lens
grep APP_IMAGE_TAG ~/app/.env    # what's serving right now
```

The rollout also self-rolls-back: if the new container fails its health check
30× (~2 min), the workflow restores the previous tag and fails the run.

---

## Things a deploy does NOT do

**Supabase migrations are manual.** Apply them in the Supabase SQL editor
**before** merging code that depends on them, or the new code meets a schema
that doesn't exist yet.

**Changing a `NEXT_PUBLIC_*` value needs a rebuild, not a restart.** Those are
compiled into the client bundle. Update the GitHub secret *and* the server's
`.env`, then re-run the workflow. Editing `.env` and restarting will appear to
do nothing — this is the single most confusing failure mode in this setup.

Server-only secrets are different: edit `.env`, then
`docker compose up -d app` picks them up on restart, no rebuild needed.

---

## Emergency: deploy without CI

If GitHub or GHCR is unreachable, the server can still build locally:

```bash
cd ~/app && git pull && docker compose up -d --build
```

Expect 8–15 minutes and heavy load on the box. Last resort only.

---

## After changing hosting or DNS

Two things live outside this repo and are easy to forget:

1. **GitHub secret `API_BASE_URL`** — all 7 cron workflows curl it. Wrong value
   means markets never lock (users can bet on in-progress matches) and stuck
   deposits are never reconciled.
2. **Squad dashboard webhook URL** — wrong value means deposits stop crediting.
