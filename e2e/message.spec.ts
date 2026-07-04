import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, settle, joinRemoteAwait, sendRemoteInvite } from './fixtures'

// Messaging: the circle chat (one Signal-style thread, its own Chat tab, shared
// inbox like a buzz) and private 1:1 threads (gift-wrapped to one member's
// personal inbox — only they can read it; the thread sheet lives behind people,
// PMs under You). Everything goes over the live relay, so the OTHER person's
// screen proves the transport.
test.describe('messaging — circle chat & private 1:1 threads', () => {
  test('Home is the full-screen map; Chat is its own tab with the composer', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    await gotoTab(A, 'home')
    // The map fills Home; the people and share bar float over the bottom of it.
    await expect(A.locator('.home-shell')).toBeVisible()
    await expect(A.locator('.map-status')).toBeVisible()
    await expect(A.locator('.member-strip')).toBeVisible()
    await expect(A.locator('#chat-input')).toHaveCount(0)
    // The composer lives on its own tab now.
    await gotoTab(A, 'chat')
    await expect(A.locator('#chat-input')).toBeVisible()
  })

  test('circle chat A→everyone — B gets a banner AND the message lands in B\'s thread', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Type into the Chat tab composer and send to everyone.
    await gotoTab(A, 'chat')
    await A.fill('#chat-input', 'dinner at eight?')
    await A.click('[data-action="chat-send"]')
    // A's own message threads immediately (my side of the conversation).
    await expect(A.locator('#chat-thread .msg.mine')).toContainText('dinner at eight?')

    const banner = B.locator('.buzz-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('dinner at eight?')
    // …and it's in B's thread too — a conversation, not a fleeting banner.
    await gotoTab(B, 'chat')
    await expect(B.locator('#chat-thread .msg')).toContainText('dinner at eight?')
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

    // A messages B privately from B's row on the Circle tab (the ✉️ button,
    // behind the row's chevron) — it opens the whole 1:1 thread, not a one-shot box.
    // Scoped to B's row specifically: A's own row now also gets a chevron once A
    // has a beacon (for "see on map"), so a bare .first() would be a coin flip.
    await gotoTab(A, 'circle')
    await expect(A.locator('.member')).toHaveCount(2)
    const bRow = A.locator('.member').filter({ hasNotText: 'You' })
    await bRow.locator('[data-action="toggle-member-actions"]').click()
    await bRow.locator('[data-action="msg-member"]').click()
    await expect(A.locator('#dm-sheet')).toBeVisible()
    await A.fill('#dm-input', 'meet you round the back')
    await A.click('[data-action="dm-send"]')
    // My message appears in the open thread.
    await expect(A.locator('#dm-thread .msg.mine')).toContainText('meet you round the back')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('meet you round the back')
    await expect(banner).toContainText('just you')

    // And B's copy lives under You → Private chats.
    await gotoTab(B, 'you')
    await expect(B.locator('.dm-row')).toContainText('meet you round the back')
    await B.locator('.dm-row').first().click()
    await expect(B.locator('#dm-thread .msg')).toContainText('meet you round the back')
  })

  test('tapping a member pin on the map opens their private thread', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Only B shares, so A's map holds exactly one pin — B's (A has no "You" pin).
    await startSharing(B)
    await settle(A)
    await gotoTab(A, 'home')

    const pin = A.locator('.map-pin')
    await expect(pin.first()).toBeVisible()
    await pin.first().click()

    // The tap opens B's private thread, marked private (the lock title).
    await expect(A.locator('#dm-sheet')).toBeVisible()
    await expect(A.locator('#dm-sheet')).toContainText('private')
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
    await A.locator('.member [data-action="toggle-member-actions"]').first().click()
    await A.locator('.member [data-action="msg-member"]').first().click()
    await A.fill('#dm-input', 'welcome aboard')
    await A.click('[data-action="dm-send"]')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('welcome aboard')
  })
})
