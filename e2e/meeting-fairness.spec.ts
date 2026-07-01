import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab, startSharing, mockOverpass, LONDON, SOHO } from './fixtures'

// Fair meeting point — FAIRNESS toggle (Slice 3b). With more than one candidate
// venue, the proposer can choose how to balance travel across the group (fairest to
// the worst-off / least total / most equal). The toggle re-ranks the venues already
// fetched — no second network call — and the pick is still settable as a rendezvous.
test.describe('meeting point — fairness toggle (Slice 3b)', () => {
  test('with ≥2 venues the proposer can rebalance travel and still set the pick', async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO)
    // Two venues near the fair point → a real choice to balance between.
    await mockOverpass(A, [
      { name: 'The Test Tavern', lat: 51.5110, lon: -0.1305, amenity: 'pub' },
      { name: 'Old Bell Cafe', lat: 51.5125, lon: -0.1290, amenity: 'cafe' },
    ])
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

    // Once the two venues are in, the balance-travel toggle appears (all three strategies).
    await expect(A.locator('[data-action="mtg-fairness"]')).toHaveCount(3, { timeout: 15_000 })
    // Rebalance to "least total travel" — re-ranks in place, no re-fetch.
    await A.click('[data-action="mtg-fairness"][data-fair="min_total"]')

    // The suggestion survives the re-rank and is still settable as the rendezvous.
    await expect(A.locator('[data-action="set-meeting-rzv"]')).toBeVisible()
    await A.click('[data-action="set-meeting-rzv"]')
    await expect(A.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })
    await expect(B.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })
  })
})
