#!/usr/bin/env bash
# Deploy the current branch to this instance.
#
#   ./scripts/deploy.sh            # deploy origin/<current branch>
#   ./scripts/deploy.sh main       # deploy a specific ref
#
# Safe-by-default: builds the new image BEFORE stopping anything, verifies the
# container passes its health check, and rolls back to the previous image if it
# doesn't. On a money app a failed deploy must not leave you with no site.
set -euo pipefail

REF="${1:-$(git rev-parse --abbrev-ref HEAD)}"
COMPOSE="docker compose"
HEALTH_URL="http://127.0.0.1:3000/api/status"
HEALTH_RETRIES=30
HEALTH_DELAY=4

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "FATAL: .env missing. Copy .env.production.example to .env and fill it in." >&2
  echo "       (Compose reads build-arg substitution ONLY from a file named .env)" >&2
  exit 1
fi

echo "==> Fetching $REF"
git fetch origin "$REF"
git checkout "$REF"
git reset --hard "origin/$REF"

# Tag the currently-running image so we can roll back to it.
PREV_IMAGE="$(docker inspect --format='{{.Image}}' "$($COMPOSE ps -q app 2>/dev/null)" 2>/dev/null || true)"
if [[ -n "$PREV_IMAGE" ]]; then
  docker tag "$PREV_IMAGE" opinions-app:rollback 2>/dev/null || true
  echo "==> Tagged rollback image"
fi

echo "==> Building (old container still serving)"
$COMPOSE build app

echo "==> Restarting app"
$COMPOSE up -d app

echo "==> Waiting for health check"
ok=0
for i in $(seq 1 $HEALTH_RETRIES); do
  if docker compose exec -T app node -e \
      "fetch('$HEALTH_URL').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok=1; break
  fi
  echo "   ...attempt $i/$HEALTH_RETRIES"
  sleep $HEALTH_DELAY
done

if [[ $ok -ne 1 ]]; then
  echo "!! Health check FAILED — rolling back" >&2
  $COMPOSE logs --tail=50 app >&2 || true
  if docker image inspect opinions-app:rollback >/dev/null 2>&1; then
    docker tag opinions-app:rollback "$($COMPOSE config --images | grep -m1 app || echo opinions-app:latest)" || true
    $COMPOSE up -d app
    echo "!! Rolled back to previous image." >&2
  else
    echo "!! No rollback image available — site may be DOWN. Investigate now." >&2
  fi
  exit 1
fi

echo "==> Healthy. Reloading proxy."
$COMPOSE up -d caddy

# Free disk on a small instance: stale images fill a 40GB volume fast, and a
# full disk is an outage.
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

echo "==> Deployed $REF ($(git rev-parse --short HEAD))"
