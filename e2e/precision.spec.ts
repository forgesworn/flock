import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, setSharePrecision, gotoTab } from './fixtures'

// The MVP's core privacy control: the slider decides the geohash precision MY
// beacons carry — so the proof lives on the OTHER person's screen. A coarse
// share renders as a "rough area" halo on B's map; an exact share collapses to
// a bare pin (halos are only drawn for radii ≥ ~30 m).
test.describe('precision slider — what the circle actually sees', () => {
  test('A shares at Town (5) → B sees a rough halo; A slides to Exact (9) → the halo collapses', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Coarse first: commit the slider BEFORE sharing so the first beacon is geohash-5.
    await setSharePrecision(A, 5)
    await startSharing(A)

    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.map-pin')).toBeVisible()
    await expect
      .poll(() => B.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(0)

    // Slide to Exact: the commit forces a prompt re-emit (the cadence gate is
    // cleared), so B's cached pin upgrades to precision 9 without waiting for
    // the heartbeat — and a 2.4 m halo is below the draw threshold.
    await setSharePrecision(A, 9)
    await expect
      .poll(() => B.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? -1), { timeout: 20_000 })
      .toBe(0)
    await expect(B.locator('.map-pin')).toBeVisible() // still on the map — just exact now
  })

  test('the slider labels speak plainly and persist per circle', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    await gotoTab(A, 'home')

    // Default is Neighbourhood (6).
    await expect(A.locator('#precision-label')).toContainText('Neighbourhood')

    // The coarse end is a whole region — Mallorca-sized, not just a city.
    await setSharePrecision(A, 3)
    await expect(A.locator('#precision-label')).toContainText('Region')
    await expect(A.locator('#precision-note')).toContainText('roughly where you are')

    // The committed value survives a reload (persisted on the circle).
    await A.reload()
    await gotoTab(A, 'home')
    await expect(A.locator('#share-precision')).toHaveValue('3')
    await expect(A.locator('#precision-label')).toContainText('Region')
  })
})
