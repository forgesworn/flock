import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, sendSOS, myPubkey, settle, gotoTab, memberPill } from './fixtures'

test.describe('remove member — cut someone off (3 people)', () => {
  // Removing a member = rotate the key and send the new seed to everyone EXCEPT
  // them. The removed device is left on the old seed: A + B keep talking, C goes
  // dark. This is the security property that makes "remove" mean something.
  test('A removes C → A\'s next alert reaches B but never C', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    const C = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await joinByCode(C, code)

    // B and C each signal once on the SHARED key, so A's roster holds them both…
    await sendBuzz(B, 'B here')
    await sendBuzz(C, 'C here')

    // …and C's receive path is demonstrably live (it gets a buzz on the shared key).
    await gotoTab(C, 'circle')
    await expect(C.locator('.buzz-banner')).toBeVisible()

    // A sees both others (this also covers the concurrent-roster-update path).
    await gotoTab(A, 'you')
    await expect(A.locator('[data-action="ask-remove"]')).toHaveCount(2)

    // A removes C — the new key is gift-wrapped to B only; C is stranded.
    // Removal is a two-step inline confirm: first tap arms (nothing sent yet),
    // Cancel disarms, arming again and confirming executes.
    const cPk = await myPubkey(C)
    await A.click(`[data-action="ask-remove"][data-pk="${cPk}"]`)
    await expect(A.locator(`[data-action="remove-member"][data-pk="${cPk}"]`)).toBeVisible()
    await A.click('[data-action="cancel-remove"]')
    await expect(A.locator('[data-action="remove-member"]')).toHaveCount(0)
    await expect(A.locator('[data-action="ask-remove"]')).toHaveCount(2) // no one removed
    await A.click(`[data-action="ask-remove"][data-pk="${cPk}"]`)
    await A.click(`[data-action="remove-member"][data-pk="${cPk}"]`)
    await settle(B, 3000) // B receives the reseed and resubscribes to the new inbox

    // A raises an SOS on the NEW key.
    await sendSOS(A)

    // B (kept in) gets it…
    await gotoTab(B, 'circle')
    await expect(memberPill(B, 'help')).toBeVisible()

    // …C (removed, stranded on the old key) never does — even though its receive
    // path was live moments ago. That's the cut-off, proven over the live relay.
    await gotoTab(C, 'circle')
    await expect(C.locator('.member .pill', { hasText: 'help' })).toHaveCount(0)
  })
})
