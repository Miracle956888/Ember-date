#!/usr/bin/env bash
#
# roll.sh - run on the SERVER to to move it onto a freshly published image.
# It is piped over ssh by .github/workflows/publish.yml:
#
#   ssh user@host "IMAGE_TAG=ghcr.io/you/ember:v1.1.0 bash -s" < deploy/roll.sh
#
# and you can also run it by hand on the box. It never rebuilds: it pulls the tag,
# repoints the compose service at it, and refuses to call it a success until the
# health endpoint answers - so a bad image fails loudly while the old container is
# still in the local cache for an instant rollback.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/ember}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required (e.g. IMAGE_TAG=ghcr.io/you/ember:v1.1.0)}"
# docker-compose.yml pins the app service to this exact image name, so retagging
# the published image onto it is all that is needed to run a deploy with no build
# step on the server.
LOCAL_PIN="${LOCAL_PIN:-ember-app:latest}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
WAIT_SECS="${WAIT_SECS:-25}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    (cd "$DEPLOY_PATH" && docker compose "$@")
  else
    (cd "$DEPLOY_PATH" && docker-compose "$@")
  fi
}

if [[ ! -d "$DEPLOY_PATH" ]]; then
  echo "no deploy directory at $DEPLOY_PATH - provision the box once with deploy/vps.sh first." >&2
  exit 1
fi
cd "$DEPLOY_PATH"
if [[ ! -f .env ]]; then
  echo "no .env in $DEPLOY_PATH - provision the box once with deploy/vps.sh before rolling." >&2
  exit 1
fi

echo "==> pulling $IMAGE_TAG"
docker pull "$IMAGE_TAG"
docker tag "$IMAGE_TAG" "$LOCAL_PIN"

# The schema migration is part of the container's start command, so a deploy that
# changes tables restarts into a migrated database. Runs idempotently.
echo "==> restarting app onto the new image"
compose up -d --no-build --wait app 2>/dev/null || compose up -d --no-build app

echo "==> waiting for $HEALTH_URL"
deadline=$((SECONDS + WAIT_SECS))
until curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "health check never passed; last 40 lines of the app log:" >&2
    compose logs --tail 40 app >&2 || true
    echo "" >&2
    echo "Roll back with: docker compose up -d --no-build app   (previous image is still local)" >&2
    exit 1
  fi
  sleep 1
done

compose ps
echo "==> on $IMAGE_TAG and healthy"
