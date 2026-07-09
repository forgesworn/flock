import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, expandMember, myPubkey, LONDON, SOHO } from './fixtures'

// Radar navigation, first slice: B selects A from the member row and gets the
// foreground motion-tracker over A's ALREADY-DISCLOSED beacon — the wire path
// (gift-wrap → relay → unwrap → presence cache → radar) proven between two real
// people. Playwright has no compass, so the spec also proves the honest
// degradation: distance guidance with a plain "no compass" line, never a
// fabricated bearing. Stop must kill the overlay at once.
test.describe('radar navigation to a person', () => {
  test("B tracks A's live share on the radar; Stop ends it", async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO) // ~700 m from A — a real bearing/distance
    await createCircle(A, { name: 'Sat night' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // exact-spot by default; the beacon auto-emits on the first fix

    // A's beacon has landed once B's roster row carries a location claim.
    const aPk = await myPubkey(A)
    await expandMember(B, aPk)
    const navBtn = B.locator(`[data-action="radar-member"][data-pk="${aPk}"]`)
    await expect(navBtn).toBeVisible()
    await navBtn.click()

    // The tracker: who, how far, how fresh — the four questions, no clutter.
    const shell = B.locator('#radar-shell')
    await expect(shell).toBeVisible()
    await expect(shell.locator('.radar-title')).toContainText(/finding/i)
    // A real distance renders (units per preference), not a placeholder dash.
    await expect(shell.locator('#radar-distance')).toHaveText(/\d/)
    await expect(shell.locator('#radar-fresh')).toHaveText(/just now|s old/)
    // The blip is on the scope: A shares exact, so it draws as a crisp dot
    // (the uncertainty band only appears for a meaningfully coarse share).
    await expect(shell.locator('#radar-blip')).toBeVisible()

    // No compass in a Playwright browser → the radar must SAY so and fall back
    // to distance guidance, not invent a bearing (the honesty rule).
    await expect(shell.locator('#radar-status')).toContainText(/no compass/i)

    // Stop: one obvious control, immediate end — overlay gone, sound/haptics with it.
    await shell.locator('.radar-stop').click()
    await expect(B.locator('#radar-shell')).toHaveCount(0)
  })
})
