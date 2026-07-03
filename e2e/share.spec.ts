import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, requestPickup, gotoTab, memberPill } from './fixtures'

test.describe('location disclosure — between people', () => {
  // Family/Private mode: nothing streams. A pick-up is an explicit disclosure —
  // a full-precision beacon that B can see.
  test('pick-up A→B — A discloses a fix, B sees A "out" with a location', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // family mode + no fence → still withholds automatically…
    await requestPickup(A) // …until A asks for a pick-up: full disclosure.

    await gotoTab(B, 'circle')
    await expect(memberPill(B, /out/)).toBeVisible()
    // A's member row shows a geohash (a real disclosed location), not "in this circle".
    await expect(B.locator('.member .when', { hasText: 'on the map' })).toBeVisible()
  })

  // Stopping sharing must read honestly on my own device: my cached pin is
  // dropped, so the map/roster can't keep claiming a live (possibly precise)
  // location that is no longer being shared.
  test("stop sharing — my own pin is dropped, the roster stops saying 'on the map'", async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })

    await startSharing(A) // coarse beacon auto-emits on the first fix
    await gotoTab(A, 'circle')
    await expect(A.locator('.member .when', { hasText: 'on the map' })).toBeVisible()

    await gotoTab(A, 'home')
    await A.click('[data-action="toggle-share"]') // plain tap-stop
    await gotoTab(A, 'circle')
    await expect(A.locator('.member .when', { hasText: 'on the map' })).toHaveCount(0)
  })

  // Share-live (night-out) mode: a coarse location streams continuously so the
  // group can see who's still out.
  test('share-live A→B — A streams a coarse location, B sees A is out', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // coarse beacon auto-emits on the first fix.

    await gotoTab(B, 'circle')
    await expect(memberPill(B, /out/)).toBeVisible()
  })
})
