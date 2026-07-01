import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab, startSharing, mockOverpass, LONDON, SOHO } from './fixtures'

// Fair meeting point — VENUE path (Slice 3). Same flow as meeting.spec.ts, but the
// proposer's device now searches real venues (via the same-origin Overpass proxy,
// mocked here for determinism) around the on-device fair point and suggests a named
// place everyone can reach. That venue name must ride the whole path: the proposer's
// suggestion card → the set-rendezvous → the recipient's map pin. Only a bounding box
// ever leaves the device; the mock proves the wiring without touching the network.
test.describe('meeting point — venue suggestion (Slice 3)', () => {
  test('A proposes; a real venue is suggested and its name reaches B as the rendezvous', async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO)
    // Overpass returns one venue near the London/Soho midpoint — the fair point.
    await mockOverpass(A, [{ name: 'The Test Tavern', lat: 51.5110, lon: -0.1305, amenity: 'pub' }])
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A)
    await startSharing(B)

    // A proposes (auto-contributes A's own coarse spot).
    await gotoTab(A, 'circle')
    await A.click('[data-action="propose-meeting"]')
    await expect(A.locator('[data-action="cancel-meeting"]')).toBeVisible()

    // B opts in with a coarse spot over the relay.
    await gotoTab(B, 'circle')
    await expect(B.locator('[data-action="share-meeting"]')).toBeVisible({ timeout: 15_000 })
    await B.click('[data-action="share-meeting"]')

    // A's device computes the fair point, then upgrades it to the named venue —
    // the suggestion card shows the real place, not a bare "Fair midpoint".
    await expect(A.getByText('The Test Tavern')).toBeVisible({ timeout: 15_000 })
    await A.click('[data-action="set-meeting-rzv"]')

    // The venue becomes the rendezvous; A flips to the live countdown.
    await expect(A.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })

    // And the venue's NAME reaches B — on the Circle countdown and, decisively, as
    // the label on B's rendezvous map pin (proving the name survived the round-trip).
    await expect(B.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })
    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.rzv-pin')).toContainText('The Test Tavern')
  })
})
