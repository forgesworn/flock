import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

// Build identity: the short git hash, stamped into the bundle (shown in the
// You tab) and emitted as /version.json so the APK can spot a newer deploy.
// Sideloaded apps never auto-update — this is the only "you're out of date"
// signal a user gets. Build APK and site from the SAME COMMIT (commit first):
// a dirty tree is marked so it can never masquerade as a released build.
const FLOCK_BUILD = (() => {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
    const dirty = execSync('git status --porcelain', { cwd: __dirname }).toString().trim() !== ''
    return dirty ? `${hash}+dev` : hash
  } catch {
    return 'dev'
  }
})()

// The PWA lives in app/ and consumes the flock library straight from src/
// (aliased), so the app always tracks the latest library code in dev.
export default defineConfig({
  root: 'app',
  base: './',
  define: {
    __FLOCK_BUILD__: JSON.stringify(FLOCK_BUILD),
    __FLOCK_BUILT_AT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [
    {
      name: 'flock-version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: FLOCK_BUILD }) })
      },
    },
  ],
  resolve: {
    alias: {
      '@forgesworn/flock': resolve(__dirname, 'src/index.ts'),
    },
  },
  build: {
    outDir: '../dist-app',
    emptyOutDir: true,
    target: 'es2022',
  },
  // Dev/e2e mirror of the production Caddy reverse-proxy: map tiles, Nominatim
  // geocoding, and Overpass venue search are served same-origin (`/tiles/*`,
  // `/nominatim/*`, `/overpass/*`) so the browser never talks to the third-party
  // CDN directly — the viewport / place-name / venue-bbox query reaches OSM from
  // this server, not the user's IP. Prod does the same in Caddy (deploy/Caddyfile).
  server: {
    proxy: {
      '/tiles': {
        target: 'https://tile.openstreetmap.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tiles/, ''),
        headers: { 'User-Agent': 'flock-dev/1.0 (+https://flock.forgesworn.dev)' },
      },
      '/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/nominatim/, ''),
        headers: { 'User-Agent': 'flock-dev/1.0 (+https://flock.forgesworn.dev)' },
      },
      // Overpass venue search for the fair meeting point — only a bbox leaves, and
      // it reaches Overpass from this server, never the user's IP (see venues.ts).
      '/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/overpass/, ''),
        headers: { 'User-Agent': 'flock-dev/1.0 (+https://flock.forgesworn.dev)' },
      },
      // Offline-basemap extract service (server/extract.mjs; prod = Caddy reverse_proxy).
      // Run it alongside dev:  GO_PMTILES_BIN=~/go/bin/go-pmtiles node server/extract.mjs
      '/api/extract': { target: 'http://localhost:8788', changeOrigin: false },
    },
  },
})
