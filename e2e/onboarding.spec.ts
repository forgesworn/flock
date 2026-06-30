import { test, expect, newPerson, createCircle, gotoTab } from './fixtures'

// Single-person UI contract: the child-first language and the "inviting is
// front-and-centre" landing. No relay needed.
test.describe('onboarding & circle setup', () => {
  test('behaviour is named by what it does (Private vs Share live), not a persona', async ({ browser }) => {
    const A = await newPerson(browser)
    await A.click('[data-action="create"]')
    const pick = A.locator('.share-pick')
    await expect(pick).toContainText('Private')
    await expect(pick).toContainText('Share live')
    // Plain-words descriptions, no jargon.
    await expect(pick).toContainText(/Hidden until you ask/i)
    await expect(pick).toContainText(/who's still out/i)
  })

  test('creating a circle lands on Circle with invite front-and-centre', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    // The 👋 lead card + the copy-invite control are both right there.
    await expect(A.locator('.invite-lead')).toBeVisible()
    await expect(A.locator('[data-action="copy-invite"]')).toBeVisible()
    await expect(A.locator('[data-action="send-invite"]')).toBeVisible()
  })

  test('lifetime: Today carries a TTL chip; Ongoing does not', async ({ browser }) => {
    const today = await newPerson(browser)
    await createCircle(today, { name: 'Sat night', mode: 'nightout', ttl: 'today' })
    await gotoTab(today, 'home')
    await expect(today.locator('.circle-chip.on .ttl')).toBeVisible()

    const ongoing = await newPerson(browser)
    await createCircle(ongoing, { name: 'Family', mode: 'family', ttl: 'ongoing' })
    await gotoTab(ongoing, 'home')
    await expect(ongoing.locator('.circle-chip.on')).toBeVisible()
    await expect(ongoing.locator('.circle-chip.on .ttl')).toHaveCount(0)
  })

  test('a lone member is nudged to invite people (Home CTA)', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    await gotoTab(A, 'home')
    await expect(A.locator('.invite-cta')).toBeVisible()
  })
})
