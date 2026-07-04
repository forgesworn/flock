import { test, expect, newPerson, createCircle, gotoTab, openSettings } from './fixtures'

test.describe('helper tips — learn, then quieten (audit Slice 12)', () => {
  test('tips show by default, dismiss singly, silence globally, and come back', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })

    // Fresh device: the Home tips are there.
    await gotoTab(A, 'home')
    await expect(A.locator('.tip')).toHaveCount(4) // share + chat + precision + find-each-other explainers

    // Dismissing one leaves the rest.
    await A.locator('.tip .tip-x').first().click()
    await expect(A.locator('.tip')).toHaveCount(3)

    // The master switch silences everything… (inside the Settings fold)
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
