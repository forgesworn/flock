import { test, expect, newPerson, createCircle, inviteCode, joinByCode, joinRemoteAwait, sendRemoteInvite, gotoTab, settle } from './fixtures'

test.describe('invites — both ways', () => {
  test('spoken word code (audit F4 hardening): the two-hop reference+gift-wrap flow lands B on the same circle', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Say it out loud' })

    await gotoTab(A, 'circle')
    await A.click('[data-action="share-word-code"]')
    // shareWordCode is async (parks the reference + gift-wraps the real invite
    // over the relay before the words render) — wait for them to land.
    await expect(A.locator('.wc-word').first()).toBeVisible()
    const words = await A.locator('.wc-word').allTextContents()
    expect(words, 'a spoken code should be six words').toHaveLength(6)
    await settle(A) // let both the parked reference and the gift-wrapped invite reach the relay

    await B.click('[data-action="join"]')
    await B.fill('#jwords', words.join(' '))
    await B.click('[data-action="join-words"]')

    // A fresh guest with no handle yet lands on the "what should this circle
    // call you?" screen first (same as the link/QR path) — skip it.
    await expect(B.locator('[data-action="join-skip"]')).toBeVisible()
    await B.click('[data-action="join-skip"]')

    await expect(B.locator('[data-action="tab"][data-tab="circle"]')).toBeVisible()
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('Say it out loud')
  })

  test('join by code (in person): the secret travels in the code, no relay needed', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    // B now holds the circle (same name in the switcher chip).
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('The Smiths')
  })

  test('join by link (the QR path): opening the link joins in one tap, then the secret is scrubbed', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    // The copy button now yields a LINK with the code in the #fragment — a camera
    // app OPENS it (bare-text QRs get offered to a web search, seed and all).
    const link = await inviteCode(A)
    expect(link).toContain('#join=')

    const B = await newPerson(browser)
    await B.goto(link)
    // A fresh guest with no handle yet lands on the "what should this circle
    // call you?" screen first (same as the word-code path) — skip it.
    await expect(B.locator('[data-action="join-skip"]')).toBeVisible()
    await B.click('[data-action="join-skip"]')
    // B lands joined, and the seed is scrubbed from the address bar immediately.
    await expect(B.locator('[data-action="tab"][data-tab="circle"]')).toBeVisible()
    expect(B.url()).not.toContain('join=')
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('The Smiths')
  })

  test('remote invite (gift-wrap over the relay): B shares a key, A sends, B auto-joins', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Lads trip' })

    const npub = await joinRemoteAwait(B) // B reveals npub + subscribes to its own inbox
    await sendRemoteInvite(A, npub) // A gift-wraps the seed to B's key → kind:1059

    // B receives the wrap and drops into the app on the new circle.
    await expect(B.locator('.circle-chip.on')).toContainText('Lads trip')
    await gotoTab(B, 'circle')
    // With A already a fellow member, the invite panel is tucked behind the
    // header's "＋ Invite" toggle (it only auto-opens when you're alone).
    await B.click('[data-action="toggle-invite"]')
    await expect(B.locator('[data-action="copy-invite"]')).toBeVisible()
  })
})
