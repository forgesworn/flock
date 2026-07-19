import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, myPubkey, gotoTab, memberPill } from './fixtures'

// Lost phone — a peer flags a member's device (left in a taxi); every screen
// shows it, and the phone itself addresses whoever finds it. Anyone can clear
// it, including the owner from the phone — proving mark AND clear round-trip
// through the selected relay.
test.describe('lost phone — a peer flags it, anyone clears it', () => {
  test("B reports A's phone lost → A shows the finder card; A clears it → B's flag drops", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // B discovers A on A's first signal (the roster travels by signals, not the invite).
    await sendBuzz(A)
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    // B flags A's phone lost — a two-step inline confirm, nothing sent until confirmed.
    const aPk = await myPubkey(A)
    await B.click(`[data-action="toggle-member-actions"][data-pk="${aPk}"]`)
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

  test("reporting lost has no free-text note — the finder card shows the fixed prompt", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await sendBuzz(A)
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    const aPk = await myPubkey(A)
    await B.click(`[data-action="toggle-member-actions"][data-pk="${aPk}"]`)
    await B.click(`[data-action="ask-lost"][data-pk="${aPk}"]`)
    // The report is a bare flag now — the composer is gone, so the confirm has no
    // free-text note field to fill; it offers only Report lost / Cancel.
    await expect(B.locator('.member.editing input')).toHaveCount(0)
    await B.click(`[data-action="report-lost"][data-pk="${aPk}"]`)

    // A's finder card carries the fixed prompt, not any composed message.
    await gotoTab(A, 'home')
    const card = A.locator('.card', { hasText: 'reported lost' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Please help it home')
  })
})
