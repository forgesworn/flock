import { chromium } from '@playwright/test'
import { BASE_URL } from '../playwright.config'

// Warm the Vite dev server (compile the app + lazy chunks) and the relay
// DNS/TLS once, so the first real test isn't racing a cold compile against a
// live-relay round-trip. Without this, run #1 is slow and occasionally flaky
// while every subsequent run is fast.
export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  try {
    for (let i = 0; i < 30; i++) {
      try {
        await page.goto(BASE_URL, { timeout: 5_000 })
        break
      } catch {
        await page.waitForTimeout(1_000)
      }
    }
    await page.getByRole('button', { name: 'Create a circle' }).waitFor({ timeout: 30_000 }).catch(() => { /* best effort */ })
    await page.waitForTimeout(1_500)
  } finally {
    await browser.close()
  }
}
