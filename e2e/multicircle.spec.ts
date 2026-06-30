import { test, expect, newPerson, createCircle, inviteCode, joinByCode, addCircle, sendSOS, gotoTab } from './fixtures'

test.describe('multi-circle', () => {
  // A person can be in many circles at once. An alert from one must surface even
  // while they're focused on another (the multi-inbox subscription model).
  test('an SOS in a background circle still surfaces', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)

    await createCircle(A, { name: 'Family', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code) // B is in Family with A

    // B opens a second, unrelated circle and focuses on it.
    await addCircle(B)
    await createCircle(B, { name: 'Trip', mode: 'family' })
    await gotoTab(B, 'home')
    await expect(B.locator('.circle-chip.on')).toContainText('Trip')

    // A raises an SOS in Family while B is looking at Trip.
    await sendSOS(A)

    // The alert surfaces globally on B's Home orb, regardless of focus.
    await gotoTab(B, 'home')
    await expect(B.locator('.orb-wrap.state-alert')).toBeVisible()
  })
})
