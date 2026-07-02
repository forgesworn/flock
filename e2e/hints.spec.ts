import { test, expect, newPerson, createCircle, gotoTab } from './fixtures'

test.describe('helper tips — learn, then quieten (audit Slice 12)', () => {
  test('tips show by default, dismiss singly, silence globally, and come back', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })

    // Fresh device: the Home tips are there.
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(2) // watch + SOS explainers

    // Dismissing one leaves the rest.
    await A.locator('.tip .tip-x').first().click()
    await expect(A.locator('.tip')).toHaveCount(1)

    // The master switch silences everything…
    await gotoTab(A, 'you')
    await A.click('[data-action="toggle-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(0)

    // …and back on, the single dismissal is remembered.
    await gotoTab(A, 'you')
    await A.click('[data-action="toggle-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(1)

    // "Bring all tips back" resets the dismissals too.
    await gotoTab(A, 'you')
    await A.click('[data-action="reset-hints"]')
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(2)
  })
})
