#!/usr/bin/env sh
# Build the PWA and rsync it to the flock host.
#
#   ./deploy/deploy.sh
#   HOST=root@95.217.39.110 REMOTE_DIR=/var/www/flock ./deploy/deploy.sh
#
# Override the default relay/tiles for a self-hosted instance:
#   VITE_DEFAULT_RELAY=wss://relay.example.com ./deploy/deploy.sh
set -eu

# Content updates are just an rsync — Caddy serves the static files live, no
# reload needed (only the one-time conf.d drop-in needed a reload; see DEPLOY.md).
HOST="${HOST:-deploy@95.217.39.110}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/flock}"

# Offline maps ("save this area") need the extract service (server/extract.mjs),
# which is live on our host — so enable the feature by default. Self-hosters without
# the service should build with VITE_OFFLINE_MAP=0 (see docs/DEPLOY.md).
export VITE_OFFLINE_MAP="${VITE_OFFLINE_MAP:-1}"

echo "→ building dist-app (offline map: ${VITE_OFFLINE_MAP})"
npm run build:app

echo "→ deploying to ${HOST}:${REMOTE_DIR}"
# Never ship prebuilt basemap tiles (app/public/basemap/*.pmtiles) — those are
# local dev/demo + market-proof extracts only. The real feature downloads each
# circle's area to OPFS at runtime via the extract service; the self-hosted
# glyphs/sprite under basemap/{fonts,sprite} DO ship.
rsync -az --delete --exclude='*.pmtiles' dist-app/ "${HOST}:${REMOTE_DIR}/"

echo "✓ deployed. https://flock.forgesworn.dev"
