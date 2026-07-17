import { defineConfig, devices } from '@playwright/test'

// flock e2e — real two-person flows over a Nostr relay.
//
// Each test drives TWO isolated browser contexts (two real identities) that talk
// to each other through a Nostr relay, exactly as two phones would. Local runs
// use relay.trotters.cc by default; CI starts a fresh RAM-only relay so pushes
// neither write production data nor inherit production flakiness. Override with
// FLOCK_E2E_RELAY for an explicit pre-deploy relay smoke pass.
//
// The app under test is the Vite dev server (root app/). VITE_DEFAULT_RELAY is
// injected below so both browser contexts always use the selected relay.

const PORT = Number(process.env.FLOCK_E2E_PORT ?? 5173)
const RELAY_PORT = Number(process.env.FLOCK_E2E_RELAY_PORT ?? 7777)
const START_LOCAL_RELAY = !!process.env.CI && !process.env.FLOCK_E2E_RELAY
const RELAY_URL = process.env.FLOCK_E2E_RELAY ??
  (START_LOCAL_RELAY ? `ws://127.0.0.1:${RELAY_PORT}` : 'wss://relay.trotters.cc')
export const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Relay round-trips dominate; be patient but not infinite.
  timeout: 90_000,
  expect: { timeout: 25_000 },
  // Flows use unique circles, but serial keeps WebSocket ordering predictable
  // and preserves the option of running the same suite against a shared relay.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    // Permissions/geolocation default for the convenience `page` fixture; the
    // two-person helpers set them per-context (see e2e/fixtures.ts).
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
    locale: 'en-GB',
    launchOptions: {
      // Software WebGL so maplibre-gl renders headless (only the map-UI spec needs it).
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swapchain'],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    ...(START_LOCAL_RELAY ? [{
      command: `node scripts/test-relay.mjs --port ${RELAY_PORT}`,
      url: `http://127.0.0.1:${RELAY_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 15_000,
      stdout: 'ignore' as const,
      stderr: 'pipe' as const,
    }] : []),
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: BASE_URL,
      env: { ...process.env, VITE_DEFAULT_RELAY: RELAY_URL },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
