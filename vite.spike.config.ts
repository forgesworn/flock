import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Isolated build for the Phase 0 background-location spike (native/spike/).
//
// Deliberately separate from the production app build (vite.config.ts): the
// spike imports Capacitor-only modules (@capacitor/core, background-geolocation,
// preferences, geolocation) that are NOT production dependencies, so they must
// never enter `npm run build:app`. The spike harness imports the geofence module
// straight from src/, so no path alias is needed here.
//
// Outputs to dist-app so the existing capacitor.config.ts (webDir: 'dist-app')
// wraps it with no further config. Running this overwrites the production app
// output — rebuild with `npm run build:app` afterwards.
//
// Build:  npx vite build -c vite.spike.config.ts   (or: npm run build:spike)
export default defineConfig({
  root: 'native/spike',
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist-app'),
    emptyOutDir: true,
    target: 'es2022',
  },
})
