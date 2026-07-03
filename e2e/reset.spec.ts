import { test, expect, newPerson, createCircle, openAdvanced } from './fixtures'

test.describe('reset device — two-step confirm', () => {
  // "Sign out & reset" wipes the key and every circle with no recovery path
  // (until root backup lands), so a single stray tap must never execute it.
  test('first tap arms, cancel disarms, confirming wipes back to onboarding', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    await openAdvanced(A)

    // First tap only arms — nothing is wiped.
    await A.click('[data-action="ask-reset"]')
    await expect(A.locator('[data-action="reset-device"]')).toBeVisible()

    // Cancel disarms and the circle is untouched.
    await A.click('[data-action="cancel-reset"]')
    await expect(A.locator('[data-action="reset-device"]')).toHaveCount(0)
    await expect(A.locator('[data-action="ask-reset"]')).toBeVisible()

    // Arm again and confirm — the device wipes back to the onboarding hero.
    await A.click('[data-action="ask-reset"]')
    await A.click('[data-action="reset-device"]')
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible()
  })
})
