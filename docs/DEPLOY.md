# Deploying flock

flock's PWA is a static bundle (`dist-app/`). It needs **HTTPS** (service worker,
geolocation, install, and later Web Push all require a secure context). The host
only ever serves static files — **no user data flows through it**. The sensitive
path (location) goes peer-to-peer through the configured **Nostr relay**, not the
web host.

## Privacy posture

flock is designed so the host (and we) capture nothing:

- **No analytics, no third-party scripts.** Fonts are self-hosted; nothing phones home.
- **Access logging is off** in the provided Caddy config.
- The browser's only outbound calls are to (a) the user-configured **Nostr relay**
  and (b) **this origin**. Map tiles (`/tiles/*`) and geocoding (`/nominatim/*`) are
  **reverse-proxied by the host** to OpenStreetMap, so the third-party CDN only ever
  sees the host — never a user's IP + map viewport (which roughly reveals where the
  circle is). All overridable at build time (below).

## Build-time configuration

| Env var | Default | Purpose |
|---|---|---|
| `VITE_DEFAULT_RELAY` | `wss://relay.trotters.cc` | Default Nostr relay (users can still change it in-app) |
| `VITE_TILE_URL` | `/tiles/{z}/{x}/{y}.png` (host-proxied → OSM) | Map tile template `{z}/{x}/{y}`; point at any tile server to bypass the proxy |
| `VITE_TILE_ATTRIBUTION` | © OpenStreetMap | Attribution shown on the map |
| `VITE_NOMINATIM_URL` | `/nominatim` (host-proxied → OSM) | Geocoding endpoint (rendezvous-by-name) |
| `VITE_OFFLINE_MAP` | `1` (canonical deploy) | Show "save this area" offline maps — **requires the extract service** below; set `0` if you haven't deployed it |

The same-origin defaults (`/tiles/*`, `/nominatim/*`) rely on the host reverse-proxying
to OpenStreetMap — the `handle_path` blocks in `deploy/Caddyfile` (and the Vite dev
proxy in `vite.config.ts`). Self-hosters using a minimal config (below) should either
copy those proxy blocks **or** set `VITE_TILE_URL` / `VITE_NOMINATIM_URL` to a tile /
Nominatim server directly.

```sh
VITE_DEFAULT_RELAY=wss://relay.example.com \
VITE_TILE_URL=https://tiles.example.com/{z}/{x}/{y}.png \
npm run build:app
```

## Before you deploy — run the checks locally

CI (`.github/workflows/ci.yml`) runs the fast gates on every push — lint, typecheck,
build, unit tests, and the Kotlin native parity suite. The **two-person Playwright
e2e suite is not in CI**: it drives two real identities through a **live Nostr relay**
and needs a **live Vite dev server**, so it runs on your machine before a deploy,
where that infra is at hand (and where it can't hammer the production relay or burn
Actions minutes on a private repo).

```sh
npm test              # unit (vitest) — fast
npm run test:e2e      # two-person e2e; Playwright self-starts the dev server
                      #   (webServer + reuseExistingServer — playwright.config.ts).
                      #   Targeted spec (the full suite is >10 min):
                      #   npm run test:e2e -- e2e/quick-action.spec.ts
```

Uses `relay.trotters.cc` by default; override with `FLOCK_E2E_RELAY` to point at a
local relay. Don't edit source mid-run — Vite HMR reloads the app under the test.

## Canonical deploy — flock.forgesworn.dev (Hetzner + Caddy)  ✅ LIVE

Shared box (`deploy@95.217.39.110`) running many sites. The deploy is **fully
isolated** — own web root + one `conf.d` drop-in — and **never touches the shared
`/etc/caddy/Caddyfile`** (which `import`s `conf.d/*.Caddyfile`).

**One-time setup (already done):**

```sh
# isolated, deploy-owned web root
ssh deploy@95.217.39.110 'sudo mkdir -p /var/www/flock && sudo chown -R deploy:deploy /var/www/flock'
# additive site drop-in (deploy/Caddyfile → conf.d, capital-C extension to match the import glob)
cat deploy/Caddyfile | ssh deploy@95.217.39.110 'sudo tee /etc/caddy/conf.d/flock.forgesworn.dev.Caddyfile >/dev/null'
# ALWAYS validate before reloading a shared box, then graceful reload (not restart)
ssh deploy@95.217.39.110 'sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy'
```

**Each deploy, from this repo (content only — no reload needed):**

```sh
npm run deploy
# = build dist-app + rsync to deploy@95.217.39.110:/var/www/flock
# override: HOST=user@host REMOTE_DIR=/srv/flock npm run deploy
```

**Android APK (`/downloads/flock.apk`, linked from `/get.html`):** when a signed
release build exists locally (`npm run apk:release` — see `native/README.md`),
`npm run deploy` also ships it to `downloads/` with a `flock.apk.sha256`
alongside. `downloads/` sits outside the rsync `--delete` sweep, so app-only
deploys never remove the hosted APK. The `/downloads/*.apk` headers and the CORS
block for the shell's `https://localhost` origin live in `deploy/Caddyfile` —
re-apply the conf.d drop-in (one-time setup commands above) after changing it.

## Offline-basemap extract service (`/api/extract`)  ✅ LIVE

Powers "save this area" (offline vector maps). `server/extract.mjs` is a small Node
service that clips a bbox from the Protomaps daily build **server-side** — so the
browser only ever talks to this origin — and streams the `.pmtiles`. On the host it
runs as `flock-extract.service` on `127.0.0.1:8791`, reverse-proxied by Caddy at
`/api/extract` (in `deploy/Caddyfile`). Public endpoint, so the service caps request
span (60 km) and concurrency (3 → 429).

One-time host setup (`deploy@95.217.39.110`):

```sh
# 1. go-pmtiles binary (Linux x86_64), installed as /usr/local/bin/go-pmtiles
curl -sSL https://github.com/protomaps/go-pmtiles/releases/download/v1.30.3/go-pmtiles_1.30.3_Linux_x86_64.tar.gz | tar xz pmtiles
sudo install -m0755 pmtiles /usr/local/bin/go-pmtiles
# 2. service code + unit
sudo mkdir -p /opt/flock-extract && sudo chown deploy:deploy /opt/flock-extract
scp server/extract.mjs deploy@95.217.39.110:/opt/flock-extract/
cat deploy/flock-extract.service | ssh deploy@95.217.39.110 'sudo tee /etc/systemd/system/flock-extract.service'
ssh deploy@95.217.39.110 'sudo systemctl daemon-reload && sudo systemctl enable --now flock-extract'
# 3. the /api/extract route is part of deploy/Caddyfile — drop it in + reload (as above)
```

To update the service code later: `scp server/extract.mjs …:/opt/flock-extract/ && ssh … 'sudo systemctl restart flock-extract'`.

## Self-hosting (anyone)

flock is meant to be self-hostable. Build with your own relay/tiles and serve
`dist-app/` from any static host over HTTPS. A minimal Caddy site:

```
yourflock.example {
    root * /var/www/flock
    file_server
    encode zstd gzip
    log { output discard }        # no access logs
}
```

nginx/Apache/Pages/etc. work too — the only requirements are HTTPS and serving
`index.html` at `/`. There are no server-side routes to rewrite.

## Notes

- This is a **preview/test** deployment. The app still keeps its identity key in
  `localStorage` (flagged in-app) — not yet hardened for real-world safety use.
- After deploy, the service worker is network-first for navigations, so updates
  are picked up on the next load.
