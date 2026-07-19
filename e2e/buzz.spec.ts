import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, setPetname, gotoTab } from './fixtures'

test.describe('buzz & names', () => {
  test('fixed group signal A→B — B gets a banner with its local label', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await sendBuzz(A)

    const banner = B.locator('.buzz-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('On my way')
  })

  test('petname — B labels A privately, and the label shows instead of the npub', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A buzz makes A appear in B's roster (ensureMember on any incoming signal).
    await sendBuzz(A)
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    await setPetname(B, 'Dad')
    await expect(B.locator('.member .who', { hasText: 'Dad' })).toBeVisible()
  })
})
