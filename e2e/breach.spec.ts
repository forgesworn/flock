import { test, expect, newPerson, createCircle, inviteCode, joinByCode, addZoneOnMap, startSharing, moveAndReshare, gotoTab, memberPill, PARIS } from './fixtures'

test.describe('geofence breach', () => {
  // Family/Private mode: a fix is withheld while inside a safe place, and
  // disclosed the moment the device leaves it.
  test('A leaves a safe place → B is alerted with A\'s location', async ({ browser }) => {
    const A = await newPerson(browser) // starts in London
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A marks "home" (current spot, London) as a safe place, then shares.
    await addZoneOnMap(A, 'safe')
    await startSharing(A)

    // Inside the safe place → withheld: B has received nothing, sees only itself.
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(1)

    // A steps well outside (Paris). Breach → full disclosure crosses the relay.
    await moveAndReshare(A, PARIS)

    // In Private mode, an automatic location disclosure happens ONLY on a breach,
    // so A appearing on B's screen with a location IS the breach, proven across the relay.
    await expect(memberPill(B, /out/)).toBeVisible()
    await expect(B.locator('.member .when', { hasText: '~' })).toBeVisible()
  })
})
