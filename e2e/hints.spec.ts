import { test, expect, newPerson, createCircle, gotoTab, openSettings } from './fixtures'

test.describe('helper tips — off by default, opt in, dismiss singly, silence globally, come back', () => {
  test('a fresh device shows no tips until you turn them on', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })

    // Fresh device: the screen should read as intuitive on its own — no tips unasked.
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(0)

    // Turn them on (inside the Settings fold).
    await openSettings(A)
    await A.click('[data-action="toggle-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(4) // share + chat + precision + find-each-other explainers

    // Dismissing one leaves the rest.
    await A.locator('.tip .tip-x').first().click()
    await expect(A.locator('.tip')).toHaveCount(3)

    // The master switch silences everything…
    await openSettings(A)
    await A.click('[data-action="toggle-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(0)

    // …and back on, the single dismissal is remembered.
    await openSettings(A)
    await A.click('[data-action="toggle-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(3)

    // "Bring all tips back" resets the dismissals too.
    await openSettings(A)
    await A.click('[data-action="reset-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(4)
  })
})
