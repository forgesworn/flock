import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    // App tests consume the library by its package name, same as the app does.
    alias: { '@forgesworn/flock': resolve(__dirname, 'src/index.ts') },
  },
  test: {
    include: ['src/**/*.test.ts', 'app/**/*.test.ts', 'server/**/*.test.mjs', 'native/**/*.test.ts', 'scripts/**/*.test.mjs'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
