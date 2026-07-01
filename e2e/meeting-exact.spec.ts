import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab, startSharing, mockOverpass, LONDON, SOHO } from './fixtures'

// Fair meeting point — PER-PERSON EXACT precision (Slice 3c). A contributor can share
// their PRECISE spot with the proposer alone, while the group still sees only their
// coarse neighbourhood cell. The exact share is gift-wrapped to the proposer's personal
// inbox (only they can decrypt it); the proposer's map then shows that person as a crisp
// EXACT dot rather than a coarse blob. This proves the targeted delivery end-to-end over
// the live relay; the "only the named recipient can decrypt" invariant is unit-tested.
test.describe('meeting point — per-person exact precision (Slice 3c)', () => {
  test('B shares exact only with the proposer; A sees B as an exact pin, A itself coarse', async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO)
    await mockOverpass(A, []) // keep the venue search off the network; not what this tests
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A)
    await startSharing(B)

    // A proposes (auto-contributes A's own COARSE spot).
    await gotoTab(A, 'circle')
    await A.click('[data-action="propose-meeting"]')

    // B opts in with EXACT — coarse to the group inbox + exact gift-wrapped to A.
    await gotoTab(B, 'circle')
    await expect(B.locator('[data-action="share-meeting-exact"]')).toBeVisible({ timeout: 15_000 })
    await B.click('[data-action="share-meeting-exact"]')

    // On A's map, B resolves to a crisp EXACT contributor pin (the personal-inbox
    // share arrived and overrode the coarse group echo); A's own spot stays coarse.
    await gotoTab(A, 'map')
    await expect(A.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(A.locator('.map-pin.contrib.exact')).toHaveCount(1, { timeout: 20_000 })
    await expect(A.locator('.map-pin.contrib:not(.exact)')).toHaveCount(1) // A's own coarse cell
  })
})
