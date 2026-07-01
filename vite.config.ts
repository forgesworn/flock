import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// The PWA lives in app/ and consumes the flock library straight from src/
// (aliased), so the app always tracks the latest library code in dev.
export default defineConfig({
  root: 'app',
  base: './',
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
  // Dev/e2e mirror of the production Caddy reverse-proxy: map tiles and Nominatim
  // geocoding are served same-origin (`/tiles/*`, `/nominatim/*`) so the browser
  // never talks to the third-party CDN directly — the viewport / place-name query
  // reaches OSM from this server, not the user's IP. Prod does the same in Caddy
  // (deploy/Caddyfile).
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
    },
  },
})
