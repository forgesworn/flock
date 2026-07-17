import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, myPubkey, gotoTab, memberPill } from './fixtures'

// Remote exact ping ("find my phone") — a member asks a LOST phone for a one-shot
// exact location. A remotely-triggered disclosure is only legitimate when every
// consent gate holds: the owner pre-authorised THIS circle, the phone is flagged
// lost, the ask is aimed at it — then a cancel window before it answers. This
// proves the full consent path end to end over the selected relay: the ask reaches
// the lost phone, its cancel banner shows, and (uncancelled) its exact beacon
// lands back on the asker. The gate logic itself is exhaustively unit-tested
// (app/src/findping.test.ts); here we prove the wire round-trip + the UX.
test.describe('find my phone — a pre-authorised lost phone answers with an exact fix', () => {
  test("A pre-authorises + is flagged lost → B asks → A's cancel window opens → A's location reaches B", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Standing consent fails closed. A deliberately opts this trusted circle in.
    await gotoTab(A, 'circle')
    const consent = A.locator('[data-action="toggle-ping-consent"]')
    await expect(consent).toHaveAttribute('aria-checked', 'false')
    await consent.click()
    await expect(consent).toHaveAttribute('aria-checked', 'true')

    // B discovers A on A's first signal.
    await sendBuzz(A, 'hello')
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)

    // B flags A's phone lost — the gate (and the anti-stalk tell on A's phone).
    const aPk = await myPubkey(A)
    await B.click(`[data-action="toggle-member-actions"][data-pk="${aPk}"]`)
    await B.click(`[data-action="ask-lost"][data-pk="${aPk}"]`)
    await B.click(`[data-action="report-lost"][data-pk="${aPk}"]`)
    await expect(memberPill(B, 'phone lost')).toBeVisible()

    // A must have processed the lost flag before the ask (it's a gate).
    await gotoTab(A, 'home')
    await expect(A.locator('.card', { hasText: 'reported lost' })).toBeVisible()

    // B asks A's phone for an exact location.
    await B.click(`[data-action="find-exact"][data-pk="${aPk}"]`)

    // A shows the cancel window — the owner's veto (nobody cancels here).
    await expect(A.locator('.findping-banner')).toBeVisible()

    // The window elapses (~10s) → A answers with one exact beacon → it reaches B:
    // A's row on B's Circle tab now shows a live location ("last seen").
    await gotoTab(B, 'circle')
    await expect(B.locator('.member').filter({ hasNotText: 'You' }).locator('.when', { hasText: 'last seen' })).toBeVisible({ timeout: 25_000 })
  })
})
