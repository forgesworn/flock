import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, settle } from './fixtures'

// Free-text messaging: a written note to the whole circle (shared inbox, like a
// buzz) and a private 1:1 (gift-wrapped to one member's personal inbox — only
// they can read it). Both go over the live relay, so a banner on the OTHER
// person's screen proves the transport.
test.describe('messaging — group note & private 1:1', () => {
  test('Home leads with the members map, not the old status orb', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    await gotoTab(A, 'home')
    // The map + its glass status chip replace the orb.
    await expect(A.locator('.home-map-shell')).toBeVisible()
    await expect(A.locator('.map-status')).toBeVisible()
    await expect(A.locator('.orb')).toHaveCount(0)
    // The group-message entry point is on Home.
    await expect(A.locator('[data-action="msg-group"]')).toBeVisible()
  })

  test('group message A→everyone — B gets a banner with the text', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Open the compose sheet from Home, type a free-text note, send to everyone.
    await gotoTab(A, 'home')
    await A.click('[data-action="msg-group"]')
    await expect(A.locator('#compose-sheet')).toBeVisible()
    await A.fill('#compose-text', 'dinner at eight?')
    await A.click('[data-action="compose-send"]')
    await expect(A.locator('#compose-sheet')).toHaveCount(0) // sheet closes on send

    const banner = B.locator('.buzz-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('dinner at eight?')
  })

  test('private 1:1 A→B — B gets a locked, private banner nobody else would', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Populate both rosters over the relay, exactly as two phones on the map would:
    // A sharing teaches B who A is (so B will ACCEPT A's DM — a stranger's is
    // dropped); B sharing teaches A who B is (so B has a row/pin to message).
    await startSharing(A)
    await startSharing(B)
    await settle(A)

    // A messages B privately from B's row on the Circle tab (the ✉️ button).
    await gotoTab(A, 'circle')
    await expect(A.locator('.member')).toHaveCount(2)
    await A.locator('.member [data-action="msg-member"]').first().click()
    await expect(A.locator('#compose-sheet')).toBeVisible()
    await A.fill('#compose-text', 'meet you round the back')
    await A.click('[data-action="compose-send"]')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('meet you round the back')
    await expect(banner).toContainText('just you')
  })
})
