import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab, openAdvanced } from './fixtures'
import type { Page } from '@playwright/test'

const PIN = 'caravan42'

async function enableLock(page: Page, pin = PIN): Promise<void> {
  await openAdvanced(page)
  await page.fill('#lock-pin', pin)
  await page.fill('#lock-pin2', pin)
  await page.click('[data-action="lock-enable"]')
  // Enabling PIN-wraps the storage secret (PBKDF2) — wait for the armed card.
  await expect(page.getByText('Locked at rest')).toBeVisible({ timeout: 15_000 })
}

/** The at-rest blob, as the disk would see it. */
function atRest(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('flock:v1') ?? '')
}

async function expireGrace(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('flockks.graceUntil', '0'))
}

test.describe('app lock — key-at-rest (Phase E)', () => {
  test('ciphertext at rest; the PIN gates a cold boot; live traffic decrypts after unlock', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await enableLock(A)

    // What the disk sees from now on: an envelope, never the state.
    await expect.poll(() => atRest(A)).toContain('"locked":1')
    const blob = await atRest(A)
    for (const tell of ['seedHex', 'The Smiths', 'identity', 'skHex']) expect(blob).not.toContain(tell)

    // Past the grace window, a cold boot is a PIN screen — no circle content.
    await expireGrace(A)
    await A.reload()
    await expect(A.getByText('Enter your PIN')).toBeVisible()
    await expect(A.locator('button', { hasText: 'The Smiths' })).toHaveCount(0)

    // A wrong PIN gets an honest refusal and no state.
    await A.fill('#lock-pin-entry', 'not-the-pin')
    await A.click('[data-action="lock-unlock"]')
    await expect(A.getByText("That's not it")).toBeVisible({ timeout: 15_000 })

    // The right PIN unlocks — and the machinery comes up whole: B's live
    // signal still decrypts on A.
    await A.fill('#lock-pin-entry', PIN)
    await A.click('[data-action="lock-unlock"]')
    await expect(A.locator('button', { hasText: 'The Smiths' })).toBeVisible({ timeout: 15_000 })
    await sendBuzz(B)
    await gotoTab(A, 'circle')
    await expect(A.locator('.buzz-banner')).toBeVisible()

    // Unlocking renewed the grace window: an immediate reload skips the PIN.
    await A.reload()
    await expect(A.locator('button', { hasText: 'The Smiths' })).toBeVisible({ timeout: 15_000 })
    await expect(A.getByText('Enter your PIN')).toHaveCount(0)
  })

  test('lock × decoy: the decoy shows no PIN screen; unhide → re-confirm → locked again', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Real circle' })
    await enableLock(A)

    // Arm hiding too, then hide.
    await A.fill('#decoy-pass', 'correct horse battery')
    await A.fill('#decoy-pass2', 'correct horse battery')
    await A.click('[data-action="decoy-enable"]')
    await expect(A.locator('[data-action="decoy-hide"]')).toBeVisible({ timeout: 15_000 })
    await A.click('[data-action="decoy-hide"]')

    // The decoy is a fresh install — crucially, NOT a PIN screen (a lock gate
    // on a "brand new" app would be the tell the decoy exists to avoid).
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible({ timeout: 15_000 })
    await expect(A.getByText('Enter your PIN')).toHaveCount(0)

    // The owner comes back with the phrase (restore screen, anything as the code).
    await A.click('[data-action="restore"]')
    await A.fill('#restore-code', 'anything at all')
    await A.fill('#restore-pass', 'correct horse battery')
    await A.click('[data-action="do-restore"]')
    await expect(A.locator('button', { hasText: 'Real circle' })).toBeVisible({ timeout: 15_000 })

    // Storage came back plaintext (deliberate, visible) — one PIN re-locks it.
    await openAdvanced(A)
    await expect(A.getByText('storage is currently unlocked')).toBeVisible()
    await A.fill('#lock-repin', PIN)
    await A.click('[data-action="lock-reconfirm"]')
    await expect(A.getByText('Locked at rest')).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => atRest(A)).toContain('"locked":1')

    // And the re-locked device gates a cold boot exactly like before.
    await expireGrace(A)
    await A.reload()
    await expect(A.getByText('Enter your PIN')).toBeVisible()
    await A.fill('#lock-pin-entry', PIN)
    await A.click('[data-action="lock-unlock"]')
    await expect(A.locator('button', { hasText: 'Real circle' })).toBeVisible({ timeout: 15_000 })
  })
})
