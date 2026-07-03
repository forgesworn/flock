import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab, openAdvanced } from './fixtures'

/** Arm hiding from the You tab (Advanced), phrase typed twice. */
async function enableHiding(page: import('@playwright/test').Page, phrase: string): Promise<void> {
  await openAdvanced(page)
  await page.fill('#decoy-pass', phrase)
  await page.fill('#decoy-pass2', phrase)
  await page.click('[data-action="decoy-enable"]')
  // Arming derives the sealing key up front (PBKDF2) — wait for the armed card.
  await expect(page.locator('[data-action="decoy-hide"]')).toBeVisible({ timeout: 15_000 })
}

/** Exit the decoy: the existing restore screen, anything as the code. */
async function unhide(page: import('@playwright/test').Page, phrase: string): Promise<void> {
  await page.click('[data-action="restore"]')
  await page.fill('#restore-code', 'anything at all')
  await page.fill('#restore-pass', phrase)
  await page.click('[data-action="do-restore"]')
}

test.describe('decoy view — hide flock under a compelled unlock (FLOCK §6)', () => {
  test('A hides → a fresh app that stays silent under B\'s signals → the phrase brings everything back', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await enableHiding(A, 'correct horse battery')

    // The covert gesture: hold the wordmark ~1.3 s. The app reboots as a
    // genuinely fresh install — welcome screen, nothing to find.
    await gotoTab(A, 'home')
    await A.locator('.topbar .brand').click({ delay: 1500 })
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible({ timeout: 15_000 })

    // Hiding survives a reload — a coercer reopening the app sees the same fresh install.
    await A.reload()
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible()

    // While hidden there are no subscriptions: B's signal must render NOTHING on A.
    await sendBuzz(B, 'you out tonight?')
    await A.waitForTimeout(3000)
    await expect(A.locator('.buzz-banner')).toHaveCount(0)
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible()

    // A probing coercer gets the GENUINE fresh-install error, never a tell.
    await unhide(A, 'not the phrase')
    await expect(A.locator('.toast')).toContainText('not a flock backup code')
    await expect(A.getByRole('button', { name: 'Restore' })).toBeVisible()

    // The owner's phrase restores the real app — circle and roster intact.
    await A.fill('#restore-pass', 'correct horse battery')
    await A.click('[data-action="do-restore"]')
    await expect(A.locator('button', { hasText: 'The Smiths' })).toBeVisible({ timeout: 15_000 })
    await gotoTab(A, 'circle')
    await expect(A.locator('.member')).toHaveCount(2)
  })

  test('the decoy is a real app — usable, resettable, and the hidden state survives it all', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Real circle' })
    await enableHiding(A, 'correct horse battery')

    // The discoverable path: the button on the card.
    await A.click('[data-action="decoy-hide"]')
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible({ timeout: 15_000 })

    // A coercer can USE the decoy — create a circle, land on inviting — it is
    // a real working app, observationally identical to a first run.
    await createCircle(A, { name: 'Coffee club' })

    // Even wiping the decoy ("Sign out & reset") must not touch the hidden state.
    await openAdvanced(A)
    await A.click('[data-action="ask-reset"]')
    await A.click('[data-action="reset-device"]')
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible()

    // The owner comes back: the REAL circle, not the coercer's.
    await unhide(A, 'correct horse battery')
    await expect(A.locator('button', { hasText: 'Real circle' })).toBeVisible({ timeout: 15_000 })
    await expect(A.locator('button', { hasText: 'Coffee club' })).toHaveCount(0)
  })
})
