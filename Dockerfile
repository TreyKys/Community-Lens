# Multi-stage build for the Opinions/Community-Lens Next.js app.
#
# Why multi-stage: the final image ships only Next's `standalone` output —
# the server bundle plus the node_modules it actually reaches — instead of the
# full workspace install. That's the difference between a ~1GB image and a
# ~150MB one, which matters on a small instance where disk and pull time are
# the constraint.
#
# Build from the REPO ROOT (the monorepo root is the build context) so the
# workspace lockfile resolves:
#   docker build -t opinions-app .

# ── deps: install workspace dependencies once, cached on lockfile only ──────
FROM node:22-alpine AS deps
WORKDIR /repo
# Copy only manifests first, so a source-only change doesn't bust this layer.
COPY package.json package-lock.json* ./
COPY packages/app/package.json ./packages/app/
# `npm ci` needs a lockfile; fall back to `install` if this repo doesn't ship
# one, so the build doesn't hard-fail on a fresh clone.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ── builder: compile the Next.js app ───────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/app/node_modules ./packages/app/node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so
# they must be present here — not just at runtime. Pass them with --build-arg.
# Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, SQUAD_SECRET_KEY, ADMIN_SECRET,
# CRON_SECRET, ...) are deliberately NOT build args: they are read at runtime
# from the container env, so they never get baked into an image layer.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_WALLET_CONNECT_ID
ARG NEXT_PUBLIC_ALCHEMY_KEY
ARG NEXT_PUBLIC_ENABLE_PHONE_AUTH
ARG NEXT_PUBLIC_TRUTH_MARKET_ADDRESS
ARG NEXT_PUBLIC_PAYMASTER_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_WALLET_CONNECT_ID=$NEXT_PUBLIC_WALLET_CONNECT_ID \
    NEXT_PUBLIC_ALCHEMY_KEY=$NEXT_PUBLIC_ALCHEMY_KEY \
    NEXT_PUBLIC_ENABLE_PHONE_AUTH=$NEXT_PUBLIC_ENABLE_PHONE_AUTH \
    NEXT_PUBLIC_TRUTH_MARKET_ADDRESS=$NEXT_PUBLIC_TRUTH_MARKET_ADDRESS \
    NEXT_PUBLIC_PAYMASTER_URL=$NEXT_PUBLIC_PAYMASTER_URL \
    NEXT_TELEMETRY_DISABLED=1

# Build placeholders: `next build` renders pages, and some server modules
# construct a Supabase client at module scope. Without *a* value the build
# crashes even though the real secret only matters at runtime.
ENV SUPABASE_SERVICE_ROLE_KEY=build_time_placeholder \
    ADMIN_SECRET=build_time_placeholder

# Memory ceiling for the build. On a 2 vCPU / 2 GB box Next spawns one build
# worker per core, each with its own V8 heap, and they collectively exceed RAM
# before swap can absorb it — the worker dies with SIGABRT ("build worker
# exited with code: null and signal: SIGABRT").
#
# Capping the old-space forces V8 to GC harder instead of growing, which keeps
# peak usage inside what 2 GB + swap can serve. Costs some build time; the
# alternative is a build that reliably fails.
ENV NODE_OPTIONS="--max-old-space-size=1536" \
    NEXT_BUILD_CPUS=1

RUN npm run build --workspace app

# ── runner: minimal runtime image ──────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run unprivileged — a container escape shouldn't land as root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# standalone/ carries server.js + the pruned node_modules; static/ and public/
# are served by the same process.
COPY --from=builder --chown=nextjs:nodejs /repo/packages/app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/packages/app/.next/static ./packages/app/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/packages/app/public ./packages/app/public

USER nextjs
EXPOSE 3000

# Hits the existing /api/status route. Compose uses this to gate restarts and
# to avoid routing traffic at a container that hasn't finished booting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/app/server.js"]
