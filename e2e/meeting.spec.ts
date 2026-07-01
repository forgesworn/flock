import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab, startSharing, mockOverpass, LONDON, SOHO } from './fixtures'

// Fair meeting point (Phase F "where") — "some of us are here, some there, where
// do we all go?" A proposes; each person OPTS IN and contributes a COARSE spot
// (neighbourhood geohash, never an exact fix); the proposer's device computes a
// fair midpoint entirely on-device and turns the pick into an ordinary rendezvous.
// Two real identities a ~1.4 km apart, talking through the live relay: A must
// collect B's contribution, compute the fair point, and hand it to B as a rendezvous.
test.describe('meeting point — propose, opt-in contribute, compute, set', () => {
  test('A proposes; B opts in; A gets a fair point and turns it into a rendezvous B receives', async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO)
    // No venues from Overpass → the flow keeps the on-device fair point (centroid).
    // This is the baseline path; the venue-enriched path is meeting-venue.spec.ts.
    await mockOverpass(A, [])
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Both need a location fix to contribute a rough spot.
    await startSharing(A)
    await startSharing(B)

    // A proposes finding a place. Proposing auto-contributes A's own coarse spot,
    // so A is immediately "in" and simply waiting for a second contribution.
    await gotoTab(A, 'circle')
    await A.click('[data-action="propose-meeting"]')
    await expect(A.locator('[data-action="cancel-meeting"]')).toBeVisible() // A's meeting card is live

    // B receives the request over the relay and is offered the opt-in prompt.
    await gotoTab(B, 'circle')
    await expect(B.locator('[data-action="share-meeting"]')).toBeVisible({ timeout: 15_000 })
    await B.click('[data-action="share-meeting"]') // B opts in — publishes a coarse spot

    // A now holds two coarse spots and its device computes the fair midpoint —
    // surfaced as a suggestion the proposer can accept.
    await expect(A.locator('[data-action="set-meeting-rzv"]')).toBeVisible({ timeout: 15_000 })
    await A.click('[data-action="set-meeting-rzv"]')

    // The fair point becomes an ordinary rendezvous: A's own card flips to the
    // live countdown (the meeting card steps aside).
    await expect(A.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })
    await expect(A.locator('[data-action="cancel-meeting"]')).toHaveCount(0)

    // And B receives that rendezvous over the relay — countdown on the Circle tab,
    // flag pin on the map — proving the whole propose→compute→set path end-to-end.
    await expect(B.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })
    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.rzv-pin')).toBeVisible()
  })
})
