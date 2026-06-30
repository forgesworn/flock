import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, setPetname, gotoTab } from './fixtures'

test.describe('buzz & names', () => {
  test('buzz A→B — B gets a banner with the reason', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await sendBuzz(A, 'Where are you?')

    const banner = B.locator('.buzz-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Where are you?')
  })

  test('petname — B labels A privately, and the label shows instead of the npub', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A buzz makes A appear in B's roster (ensureMember on any incoming signal).
    await sendBuzz(A, 'hello')
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    await setPetname(B, 'Dad')
    await expect(B.locator('.member .who', { hasText: 'Dad' })).toBeVisible()
  })
})
