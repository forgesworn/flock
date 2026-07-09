import { test, expect, createCircle } from './fixtures'
import { BASE_URL } from '../playwright.config'

test.describe('location permission denied — a way out, not a dead end (audit Slice 8)', () => {
  test('the toggle stays honest and an actionable card explains how to fix it', async ({ browser }) => {
    // Playwright's harness auto-resolves geolocation even in ungranted contexts,
    // so simulate the DENIED browser at the API boundary — byte-for-byte what a
    // real blocked permission hands the app (error callback, code 1).
    const context = await browser.newContext({ baseURL: BASE_URL, locale: 'en-GB' })
    await context.addInitScript(() => {
      const denied = { code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }
      navigator.geolocation.watchPosition = ((_ok: unknown, err?: (e: unknown) => void) => { setTimeout(() => err?.(denied), 50); return 1 }) as typeof navigator.geolocation.watchPosition
      navigator.geolocation.getCurrentPosition = ((_ok: unknown, err?: (e: unknown) => void) => { setTimeout(() => err?.(denied), 50) }) as typeof navigator.geolocation.getCurrentPosition
    })
    const A = await context.newPage()
    await A.goto('/')
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible()
    await createCircle(A, { name: 'The Smiths' })
    await A.click('[data-action="tab"][data-tab="home"]')

    await A.click('[data-action="toggle-share"]')
    // A persistent card says what happened and how to fix it…
    await expect(A.locator('.geo-issue')).toContainText("can't see your location")
    // …and the button is honest — sharing reverted to the private state (its
    // label offers to Share again).
    await expect(A.locator('[data-action="toggle-share"]')).toHaveAttribute('aria-label', 'Share location')

    // Retry with permission still blocked: the card comes straight back.
    await A.click('[data-action="geo-retry"]')
    await expect(A.locator('.geo-issue')).toContainText("can't see your location")
  })
})
