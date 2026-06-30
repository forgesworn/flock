import { test, expect, newPerson, createCircle, gotoTab } from './fixtures'

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

    // Safe place — saved at the current map centre.
    await A.click('[data-action="add-zone"][data-kind="safe"]')
    await A.click('[data-action="save-zone"]')
    await expect(A.locator('.zone-row', { hasText: 'Safe place' })).toBeVisible()

    // Private place — the inverse geofence (amber dot).
    await A.click('[data-action="add-zone"][data-kind="noreport"]')
    await A.click('[data-action="save-zone"]')
    await expect(A.locator('.dot-private')).toBeVisible()
  })
})
