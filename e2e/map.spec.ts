import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, memberPill, setPetname } from './fixtures'

test.describe('map — the circle\'s live locations', () => {
  test('the map renders with real height (regression guard)', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Home' })
    await gotoTab(A, 'map')

    // Wait for maplibre to construct (style loaded).
    await expect(A.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await A.waitForTimeout(1_500)

    // Regression guard: the map silently rendered blank because maplibre tags
    // #map with `.maplibregl-map { position: relative }`, which (equal specificity,
    // loaded later) beat our `.map-canvas { position: absolute; inset: 0 }` and
    // collapsed the container to height 0. Tiles still loaded and the canvas stayed
    // "visible", so only an explicit height check catches it.
    expect(await A.locator('#map').evaluate((el) => (el as HTMLElement).clientHeight)).toBeGreaterThan(100)
  })

  // The point of the map: when someone discloses a location, you SEE them on it.
  test('B sees A as a pin on the map once A shares a location', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Sat night' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // a coarse beacon auto-emits on the first fix.

    // B receives the beacon (row pill), then opens the map and sees A's pin.
    await gotoTab(B, 'circle')
    await expect(memberPill(B, /out/)).toBeVisible()

    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.map-pin')).toBeVisible()

    // A shared coarsely (the slider defaults to geohash-6, ~600 m) — so the pin
    // must carry a "rough area" halo, not a deceptively exact point. Poll the
    // drawn halo count (the source may populate a beat after the marker).
    await expect
      .poll(() => B.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(0)

    // Friendlier label: B nicknames A, and the pin shows the petname — not hex initials.
    await setPetname(B, 'Alex')
    await gotoTab(B, 'map')
    await expect(B.locator('.map-pin .tag', { hasText: 'Alex' })).toBeVisible()

    // Presence + petname must survive a refresh. Beacons and nicknames are cached
    // on-device, so reloading B still shows A's rough area labelled "Alex" — without
    // waiting up to 5 min for A's next beacon. A is stationary (its heartbeat won't
    // re-fire in this window), so this proves the on-device cache, not a re-broadcast.
    await B.reload()
    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.map-pin .tag', { hasText: 'Alex' })).toBeVisible()
    await expect
      .poll(() => B.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(0)
  })
})
