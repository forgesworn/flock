import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, settle, joinRemoteAwait, sendRemoteInvite } from './fixtures'

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

  test('tapping a member pin on the map opens a private compose sheet for them', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Only B shares, so A's map holds exactly one pin — B's (A has no "You" pin).
    await startSharing(B)
    await settle(A)
    await gotoTab(A, 'map')

    const pin = A.locator('.map-pin')
    await expect(pin.first()).toBeVisible()
    await pin.first().click()

    // The tap opens the compose sheet aimed at B, marked private (the lock title).
    await expect(A.locator('#compose-sheet')).toBeVisible()
    await expect(A.locator('#compose-sheet')).toContainText('private')
  })

  test('cold start — a freshly-invited member accepts the inviter\'s first DM', async ({ browser }) => {
    // The members-gate drops DMs from unknown senders. A remote invite carries the
    // inviter's key in its seal, so the joiner seeds their roster with the inviter
    // on receipt — and A's very first message (before B has shared anything) lands.
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const npub = await joinRemoteAwait(B)
    await sendRemoteInvite(A, npub) // A now has B; B, on receipt, seeds A into its roster
    await settle(B)

    // A messages B immediately — B has never emitted a beacon/buzz/join signal.
    await gotoTab(A, 'circle')
    await A.locator('.member [data-action="msg-member"]').first().click()
    await A.fill('#compose-text', 'welcome aboard')
    await A.click('[data-action="compose-send"]')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('welcome aboard')
  })
})
