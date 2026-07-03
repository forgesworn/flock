import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, memberPill } from './fixtures'

test.describe('location disclosure — between people', () => {
  // Stopping sharing must read honestly on my own device: my cached pin is
  // dropped, so the map/roster can't keep claiming a live (possibly precise)
  // location that is no longer being shared.
  test("stop sharing — my own pin is dropped, the roster stops saying 'on the map'", async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Sat night' })

    await startSharing(A) // a beacon at the slider's precision auto-emits on the first fix
    await gotoTab(A, 'circle')
    await expect(A.locator('.member .when', { hasText: 'on the map' })).toBeVisible()
    // Lost-phone breadcrumb: the row carries the disclosed detail + an absolute
    // "last seen" clock, and a see-on-map jump.
    await expect(A.locator('.member .when', { hasText: 'last seen' })).toBeVisible()
    await expect(A.locator('[data-action="see-on-map"]')).toBeVisible()

    await gotoTab(A, 'home')
    await A.click('[data-action="toggle-share"]') // plain tap-stop
    await gotoTab(A, 'circle')
    await expect(A.locator('.member .when', { hasText: 'on the map' })).toHaveCount(0)
  })

  // Live sharing: a coarse location streams continuously so the group can see
  // who's out and roughly where.
  test('share-live A→B — A streams a coarse location, B sees A is out', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Sat night' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // coarse beacon auto-emits on the first fix.

    await gotoTab(B, 'circle')
    await expect(memberPill(B, /out/)).toBeVisible()
  })
})
