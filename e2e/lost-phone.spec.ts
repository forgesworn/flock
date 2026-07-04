import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, myPubkey, gotoTab, memberPill } from './fixtures'

// Lost phone — a peer flags a member's device (left in a taxi); every screen
// shows it, and the phone itself addresses whoever finds it. Anyone can clear
// it, including the owner from the phone — proving mark AND clear round-trip
// through the live relay.
test.describe('lost phone — a peer flags it, anyone clears it', () => {
  test("B reports A's phone lost → A shows the finder card; A clears it → B's flag drops", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // B discovers A on A's first signal (the roster travels by signals, not the invite).
    await sendBuzz(A, 'hello')
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    // B flags A's phone lost — a two-step inline confirm, nothing sent until confirmed.
    const aPk = await myPubkey(A)
    await B.click(`[data-action="ask-lost"][data-pk="${aPk}"]`)
    await B.click(`[data-action="report-lost"][data-pk="${aPk}"]`)
    await expect(memberPill(B, 'phone lost')).toBeVisible()

    // A's phone — in whoever's hands — shows the finder card on Home.
    await gotoTab(A, 'home')
    await expect(A.locator('.card', { hasText: 'reported lost' })).toBeVisible()

    // One tap from the phone clears it for everyone.
    await A.click('[data-action="found-phone"]')
    await expect(A.locator('.card', { hasText: 'reported lost' })).toHaveCount(0)
    await expect(memberPill(B, 'phone lost')).toHaveCount(0)
  })

  test("B's custom note shows on A's finder card instead of the generic text", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await sendBuzz(A, 'hello')
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    const aPk = await myPubkey(A)
    await B.click(`[data-action="ask-lost"][data-pk="${aPk}"]`)
    await B.fill(`#lost-note-${aPk}`, 'left in the blue Uber')
    await B.click(`[data-action="report-lost"][data-pk="${aPk}"]`)

    await gotoTab(A, 'home')
    const card = A.locator('.card', { hasText: 'reported lost' })
    await expect(card).toContainText('left in the blue Uber')
  })
})
