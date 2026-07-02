import { test, expect, newPerson, createCircle, inviteCode, joinByCode, addZoneOnMap, setLocation, startSharing, sendSOS, gotoTab, memberPill, LONDON } from './fixtures'

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

  // The fail-safe direction under GPS noise: a fix just OUTSIDE the zone edge
  // whose accuracy disc straddles it might really be at the sensitive address —
  // the crisp check used to disclose full precision here. Possibly inside ⇒ capped.
  test('SOS on an imprecise fix near a Private place edge withholds the address', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await addZoneOnMap(A, 'noreport') // home = a Private place (withhold), 300 m at LONDON
    // 350 m east of home — 50 m beyond the edge — but the fix is only good to
    // ±150 m, so it straddles the boundary: A may well still be at home.
    const mPerDegLon = 111_320 * Math.cos((LONDON.latitude * Math.PI) / 180)
    await setLocation(A, { latitude: LONDON.latitude, longitude: LONDON.longitude + 350 / mPerDegLon, accuracy: 150 })
    await startSharing(A)
    await sendSOS(A)

    await gotoTab(B, 'circle')
    // The alarm still fires…
    await expect(memberPill(B, 'help')).toBeVisible()
    // …but the uncertain fix is never disclosed — the address stays hidden.
    await expect(B.locator('.member .when', { hasText: '~' })).toHaveCount(0)
  })
})
