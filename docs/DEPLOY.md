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
- The only outbound calls are to (a) the user-configured **Nostr relay** and
  (b) the **map tile server** — both overridable at build time so a self-hoster
  can point at their own and avoid any third party.

## Build-time configuration

| Env var | Default | Purpose |
|---|---|---|
| `VITE_DEFAULT_RELAY` | `wss://relay.trotters.cc` | Default Nostr relay (users can still change it in-app) |
| `VITE_TILE_URL` | OpenStreetMap | Map tile template `{z}/{x}/{y}` |
| `VITE_TILE_ATTRIBUTION` | © OpenStreetMap | Attribution shown on the map |

```sh
VITE_DEFAULT_RELAY=wss://relay.example.com \
VITE_TILE_URL=https://tiles.example.com/{z}/{x}/{y}.png \
npm run build:app
```

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
