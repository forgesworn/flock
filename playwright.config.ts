import { defineConfig, devices } from '@playwright/test'

// flock e2e — real two-person flows over a live relay.
//
// Each test drives TWO isolated browser contexts (two real identities) that talk
// to each other through a Nostr relay, exactly as two phones would. The relay is
// relay.trotters.cc by default (our no-log relay); override with FLOCK_E2E_RELAY
// to point at a local relay in CI if live flakiness ever bites.
//
// The app under test is the Vite dev server (root app/), which defaults to
// relay.trotters.cc — so no build step or env wiring is needed for the happy path.

const PORT = Number(process.env.FLOCK_E2E_PORT ?? 5173)
export const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Live relay round-trips dominate; be patient but not infinite.
  timeout: 90_000,
  expect: { timeout: 25_000 },
  // The shared live relay is gentler with one worker; flows use unique circles so
  // they never collide, but serial keeps WS pressure and ordering predictable.
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
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
