import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, memberPill } from './fixtures'

// Single-person map UI: the two zone kinds the privacy model rests on.
// "Safe places" (you're told if I leave) and "Private places" (I stay hidden,
// even in an emergency). Exercises the real maplibre add-flow.
test.describe('map — safe & private places', () => {
  test('add a Safe place and a Private place; each lands in its own list', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Home', mode: 'family' })
    await gotoTab(A, 'map')

    // Wait for maplibre to construct (style loaded) before editing zones.
    await expect(A.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await A.waitForTimeout(1_500)

    // Regression guard: the map silently rendered blank because maplibre tags
    // #map with `.maplibregl-map { position: relative }`, which (equal specificity,
    // loaded later) beat our `.map-canvas { position: absolute; inset: 0 }` and
    // collapsed the container to height 0. Tiles still loaded and the canvas stayed
    // "visible", so only an explicit height check catches it.
    expect(await A.locator('#map').evaluate((el) => (el as HTMLElement).clientHeight)).toBeGreaterThan(100)

    // Safe place — saved at the current map centre.
    await A.click('[data-action="add-zone"][data-kind="safe"]')
    await A.click('[data-action="save-zone"]')
    await expect(A.locator('.zone-row', { hasText: 'Safe place' })).toBeVisible()

    // Private place — the inverse geofence (amber dot).
    await A.click('[data-action="add-zone"][data-kind="noreport"]')
    await A.click('[data-action="save-zone"]')
    await expect(A.locator('.dot-private')).toBeVisible()
  })

  // The point of the map: when someone discloses a location, you SEE them on it.
  test('B sees A as a pin on the map once A shares a location', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // night-out: a coarse beacon auto-emits on the first fix.

    // B receives the beacon (row pill), then opens the map and sees A's pin.
    await gotoTab(B, 'circle')
    await expect(memberPill(B, /out/)).toBeVisible()

    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.map-pin')).toBeVisible()
  })
})
