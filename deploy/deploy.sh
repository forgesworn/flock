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
# downloads/ (the Android APK) is excluded from --delete so an app-only deploy
# never removes the APK already on the host.
rsync -az --delete --exclude='*.pmtiles' --exclude='downloads/' dist-app/ "${HOST}:${REMOTE_DIR}/"

# Ship the Android APK (linked from get.html) when a signed release build exists
# locally — `npm run apk:release` first. Its SHA-256 goes alongside so careful
# users can verify the download, plus downloads/apk.json — the published APK's
# build stamp that the installed shell's update check compares against.
#
# EVERY APK artefact is stamped from the APK's OWN embedded build, never the
# website's dist-app/version.json: the site redeploys far more often than a new
# APK ships, so a website-only deploy must not rename the download or bump the
# update marker — otherwise installed shells nag about a phantom update
# (app.ts isApkUpdateAvailable). The ground truth of what __FLOCK_BUILD__ is
# inside this APK is its bundled assets/public/version.json.
APK="android/app/build/outputs/apk/release/flock-release.apk"
if [ -f "${APK}" ]; then
  echo "→ shipping Android APK"
  APK_BUILD=$(unzip -p "${APK}" assets/public/version.json 2>/dev/null | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')
  APK_BUILD="${APK_BUILD:-unknown}"
  echo "  APK build: ${APK_BUILD}"
  shasum -a 256 "${APK}" | awk -v n="flock-${APK_BUILD}.apk" '{print $1 "  " n}' > /tmp/flock.apk.sha256
  printf '{"build":"%s"}\n' "${APK_BUILD}" > /tmp/flock.apk.json
  ssh "${HOST}" "mkdir -p ${REMOTE_DIR}/downloads"
  rsync -az "${APK}" "${HOST}:${REMOTE_DIR}/downloads/flock.apk"
  rsync -az /tmp/flock.apk.sha256 "${HOST}:${REMOTE_DIR}/downloads/flock.apk.sha256"
  rsync -az /tmp/flock.apk.json "${HOST}:${REMOTE_DIR}/downloads/apk.json"
  rm -f /tmp/flock.apk.sha256 /tmp/flock.apk.json
else
  echo "  (no local release APK — skipping; run 'npm run apk:release' to ship one)"
fi

echo "✓ deployed. https://flock.forgesworn.dev"
