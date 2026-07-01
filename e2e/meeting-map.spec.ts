import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab, startSharing, mockOverpass, LONDON, SOHO } from './fixtures'

// Fair meeting point — MAP overlays (Slice 3d). While the proposer runs a search,
// the map shows each contributor's cell at its disclosed precision (a distinct
// violet "rough area" pin) and the suggested venue as its own pin — so the proposer
// can eyeball the inputs and the pick before committing it. Marker DOM is present
// regardless of WebGL paint, so these assertions are robust in headless.
test.describe('meeting point — map overlays (Slice 3d)', () => {
  test('the proposer sees contributor cells + the venue pin on the map', async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO)
    await mockOverpass(A, [{ name: 'The Test Tavern', lat: 51.5110, lon: -0.1305, amenity: 'pub' }])
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A)
    await startSharing(B)

    await gotoTab(A, 'circle')
    await A.click('[data-action="propose-meeting"]')
    await gotoTab(B, 'circle')
    await expect(B.locator('[data-action="share-meeting"]')).toBeVisible({ timeout: 15_000 })
    await B.click('[data-action="share-meeting"]')

    // A's device computes the venue; now view it on the map.
    await expect(A.getByText('The Test Tavern')).toBeVisible({ timeout: 15_000 })
    await gotoTab(A, 'map')
    await expect(A.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    // The suggested venue is pinned and named…
    await expect(A.locator('.venue-pin')).toContainText('The Test Tavern')
    // …and both contributors (A's own spot + B's) show as violet contributor cells.
    await expect(A.locator('.map-pin.contrib')).toHaveCount(2)
  })
})
