import { test, expect, newPerson, createCircle, inviteCode, joinByCode, joinRemoteAwait, sendRemoteInvite, gotoTab } from './fixtures'

test.describe('invites — both ways', () => {
  test('join by code (in person): the secret travels in the code, no relay needed', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    // B now holds the circle (same name in the switcher chip).
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('The Smiths')
  })

  test('remote invite (gift-wrap over the relay): B shares a key, A sends, B auto-joins', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Lads trip', mode: 'nightout' })

    const npub = await joinRemoteAwait(B) // B reveals npub + subscribes to its own inbox
    await sendRemoteInvite(A, npub) // A gift-wraps the seed to B's key → kind:1059

    // B receives the wrap and drops into the app on the new circle.
    await expect(B.locator('.circle-chip.on')).toContainText('Lads trip')
    await gotoTab(B, 'circle')
    await expect(B.locator('[data-action="copy-invite"]')).toBeVisible()
  })
})
