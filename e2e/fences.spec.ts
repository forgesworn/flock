import { test, expect, newPerson, createCircle, inviteCode, joinByCode, addZoneOnMap, startSharing, moveAndReshare, gotoTab, memberPill, PARIS } from './fixtures'

test.describe('safe places sync across the circle', () => {
  // The flagship gap the audit found: a guardian's safe place used to exist only
  // on their own phone. Now the set syncs — one person draws it, every phone
  // enforces it. The proof: B breaches a fence B never configured.
  test('A draws a safe place → it lands on B → B leaving it alerts A', async ({ browser }) => {
    const A = await newPerson(browser) // London
    const B = await newPerson(browser) // London — inside the fence A will draw
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A draws "home" (300 m at London); the full set syncs to the circle…
    await addZoneOnMap(A, 'safe')

    // …and appears on B's map panel with zero setup on B's part.
    await gotoTab(B, 'map')
    await expect(B.locator('.zone-row', { hasText: 'Safe place 1' })).toBeVisible()

    // B shares from INSIDE the synced fence → withheld: A sees only itself.
    await startSharing(B)
    await gotoTab(A, 'circle')
    await expect(A.locator('.member')).toHaveCount(1)

    // B steps well outside. The breach fires on B's device — evaluated against
    // the fence A drew — and A is alerted with B's location, over the live relay.
    await moveAndReshare(B, PARIS)
    await expect(memberPill(A, /out/)).toBeVisible()
    await expect(A.locator('.member .when', { hasText: '~' })).toBeVisible()
  })

  // Deleting must sync too — an empty set is still a set (latest-wins), or a
  // removed fence would keep firing breaches from other phones forever.
  test('deleting the safe place clears it from B as well', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await addZoneOnMap(A, 'safe')
    await gotoTab(B, 'map')
    await expect(B.locator('.zone-row', { hasText: 'Safe place 1' })).toBeVisible()

    await A.click('[data-action="del-zone"][data-i="0"]')
    await expect(B.locator('.zone-row', { hasText: 'Safe place' })).toHaveCount(0)
  })
})
