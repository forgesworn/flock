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

  // Safety (Phase H): a breach must be CONFIDENT. An imprecise fix that reads just
  // outside a safe place — but whose uncertainty straddles the edge — must NOT
  // disclose. (The old crisp check would have cried wolf here.)
  test('an imprecise fix near a safe-zone edge does not fire a false breach', async ({ browser }) => {
    const A = await newPerson(browser) // London
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await addZoneOnMap(A, 'safe') // "home" at London, ~300 m radius
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(1) // B has heard nothing from A

    // A sits ~350 m east — just past the 300 m edge — but the fix is only ±300 m,
    // so we cannot be sure A actually left. A confident-only breach must NOT fire.
    await A.context().setGeolocation({ latitude: 51.5074, longitude: -0.12275, accuracy: 300 })
    await startSharing(A)
    await B.waitForTimeout(3000) // a false breach would publish on the first fix (~1 s)
    await expect(B.locator('.member')).toHaveCount(1) // still nothing disclosed

    // Step well outside with a confident (exact) fix → a real breach still crosses.
    await moveAndReshare(A, PARIS)
    await expect(memberPill(B, /out/)).toBeVisible()
    await expect(B.locator('.member .when', { hasText: '~' })).toBeVisible()
  })
})
