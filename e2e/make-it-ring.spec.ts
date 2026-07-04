import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, myPubkey, gotoTab, memberPill } from './fixtures'

// "Make it ring" — a phone the circle has flagged lost plays an incoming
// TARGETED buzz as a loud alarm, so it's findable by sound (the back-of-a-taxi
// minutes problem). No protocol change: on the wire it's an ordinary targeted
// buzz; the LOST phone escalates it on receipt (app/src/ring.ts). The native
// alarm channel can't be driven in a browser, so we assert the observable in-app
// proof — the loud "being rung" card appears on the lost phone the moment the
// finder rings it, over the live relay.
test.describe('make it ring — a lost phone sounds when a member rings it', () => {
  test("B flags A lost then rings it → A's phone goes to a 'ringing' card; A clears it → the card + flag drop", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Night out' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // B discovers A on A's first signal (the roster travels by signals).
    await sendBuzz(A, 'hello')
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    // B flags A's phone lost — the two-step inline confirm.
    const aPk = await myPubkey(A)
    await B.click(`[data-action="ask-lost"][data-pk="${aPk}"]`)
    await B.click(`[data-action="report-lost"][data-pk="${aPk}"]`)
    await expect(memberPill(B, 'phone lost')).toBeVisible()

    // A must have PROCESSED the lost flag before the ring lands — that flag is
    // the gate that turns a plain buzz into an alarm. Its Home shows the finder
    // card, proving the lost report arrived.
    await gotoTab(A, 'home')
    await expect(A.locator('.card', { hasText: 'reported lost' })).toBeVisible()

    // B rings it. On A — in whoever's hands — the finder card goes loud.
    await B.click(`[data-action="make-it-ring"][data-pk="${aPk}"]`)
    await expect(A.locator('.card.ringing', { hasText: 'This phone is ringing' })).toBeVisible()

    // One tap from the phone clears it: the ring card AND the circle's flag drop.
    await A.click('[data-action="found-phone"]')
    await expect(A.locator('.card.ringing')).toHaveCount(0)
    await expect(memberPill(B, 'phone lost')).toHaveCount(0)
  })
})
