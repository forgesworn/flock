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
})
