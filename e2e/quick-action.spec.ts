import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, setSharePrecision, quickAction, comeToMe, gotoTab } from './fixtures'

// The front-page "buzz the circle" chips: one tap → the other person's phone
// shows a banner with the reason. "Come to me" is the special one — it asks
// first, then buzzes AND drops a one-shot exact pin that overrides the slider
// once, without changing it.
test.describe('quick actions — buzz the circle from Home', () => {
  test('"Where are you?" chip A→B — B gets the banner', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await quickAction(A, 'Where are you?')

    const banner = B.locator('.buzz-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Where are you?')
  })

  test('"Come to me" — B gets the banner AND a one-shot exact pin while A\'s slider stays coarse', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A shares coarsely (Town, geohash-5) — B sees a rough halo.
    await setSharePrecision(A, 5)
    await startSharing(A)
    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => B.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(0)

    // The chip arms an inline confirm — nothing is sent until A says yes.
    await comeToMe(A)

    // B: the buzz banner…
    await expect(B.locator('.buzz-banner')).toContainText('Come to me')
    // …and A's pin upgrades to the one-shot exact beacon (precision 9 → halo collapses).
    await expect
      .poll(() => B.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? -1), { timeout: 20_000 })
      .toBe(0)

    // A's slider was NOT changed by the one-shot — the ambient share stays coarse.
    await gotoTab(A, 'home')
    await expect(A.locator('#share-precision')).toHaveValue('5')
  })
})
