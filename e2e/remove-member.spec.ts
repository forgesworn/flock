import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, myPubkey, settle, gotoTab, openAdvanced } from './fixtures'

test.describe('remove member — cut someone off (3 people)', () => {
  // Removing a member = rotate the key and send the new seed to everyone EXCEPT
  // them. The removed device is left on the old seed: A + B keep talking, C goes
  // dark. This is the security property that makes "remove" mean something.
  test('A removes C → A\'s next buzz reaches B but never C', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    const C = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await joinByCode(C, code)

    // B and C each signal once on the SHARED key, so A's roster holds them both…
    await sendBuzz(B, 'B here')
    await sendBuzz(C, 'C here')

    // …and C's receive path is demonstrably live (it gets a buzz on the shared key).
    await gotoTab(C, 'circle')
    await expect(C.locator('.buzz-banner')).toBeVisible()
    await C.click('[data-action="dismiss-buzz"]') // clear it — the assertion below must see only post-removal traffic

    // A sees both others (this also covers the concurrent-roster-update path).
    await openAdvanced(A)
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

    // A buzzes on the NEW key.
    await sendBuzz(A, 'new key check')

    // B (kept in) gets it…
    await expect(B.locator('.buzz-banner')).toContainText('new key check')

    // …C (removed, stranded on the old key) never does — even though its receive
    // path was live moments ago. That's the cut-off, proven over the live relay.
    await settle(C, 2000)
    await expect(C.locator('.buzz-banner')).toHaveCount(0)
  })

  // The security property above is covered end-to-end via the Advanced fold;
  // this just proves Remove is ALSO reachable right on the Circle tab's member
  // row — not buried three taps deep in You -> Settings -> Advanced, which is
  // where someone actually looking at their roster would expect to find it.
  test('Remove is reachable directly from the Circle tab, not just Advanced settings', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await sendBuzz(B, 'B here') // seed A's roster with B

    await gotoTab(A, 'circle')
    const bPk = await myPubkey(B)
    const row = A.locator('.member', { hasText: 'Member' }).first()
    await expect(row.locator('[data-action="ask-remove"]')).toBeVisible()
    await row.locator('[data-action="ask-remove"]').click()
    await expect(A.locator(`[data-action="remove-member"][data-pk="${bPk}"]`)).toBeVisible()
    await A.click('[data-action="cancel-remove"]') // don't actually remove — the confirm path is covered above
  })
})
