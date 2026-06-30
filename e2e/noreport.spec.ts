import { test, expect, newPerson, createCircle, inviteCode, joinByCode, addZoneOnMap, startSharing, sendSOS, gotoTab, memberPill } from './fixtures'

test.describe('no-report (Private place) — caps disclosure even on an SOS', () => {
  // The headline privacy guarantee: an SOS raised over a sensitive address fires
  // the alert, but never pins the building.
  test('SOS inside a Private place reaches B but withholds the address', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await addZoneOnMap(A, 'noreport') // home = a Private place (withhold)
    await startSharing(A) // A has a precise fix — but it sits inside the Private place
    await sendSOS(A) // …and still raises the alarm.

    await gotoTab(B, 'circle')
    // The alert reaches B…
    await expect(memberPill(B, 'help')).toBeVisible()
    // …but no location is ever pinned (no "~geohash" sub on any member row).
    await expect(B.locator('.member .when', { hasText: '~' })).toHaveCount(0)
  })
})
