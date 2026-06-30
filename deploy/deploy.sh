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

echo "→ building dist-app"
npm run build:app

echo "→ deploying to ${HOST}:${REMOTE_DIR}"
rsync -az --delete dist-app/ "${HOST}:${REMOTE_DIR}/"

echo "✓ deployed. https://flock.forgesworn.dev"
