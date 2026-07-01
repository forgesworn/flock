import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab } from './fixtures'

// Rendezvous polish — "be at a place by a time", finished off:
//   • pick the meeting point straight on the map (the crosshair idiom, no typing),
//   • the deadline counts down LIVE (a 1 s ticker, not just the 30 s refresh),
//   • the place shows as a distinct flag pin on everyone's map.
// Two real identities through the live relay: A sets it, B must SEE all three.
test.describe('rendezvous — map-pick, live countdown, map pin', () => {
  test('A picks a meeting point on the map; B sees the flag pin and a ticking countdown', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Sat night', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A picks the spot on the map — no address typed. "Pick on map" jumps to the
    // map with the crosshair up; panning is the pick, "Set rendezvous here" reads
    // the centre (same idiom as the safe/private-place editor).
    await gotoTab(A, 'circle')
    await A.click('[data-action="rzv-pick"]')
    await expect(A.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await A.waitForTimeout(1_500) // let the view centre on A's location
    await expect(A.locator('#crosshair')).toBeVisible()
    await A.click('[data-action="rzv-pick-set"]')

    // Back on the Circle screen with the rendezvous set and a live countdown showing.
    await expect(A.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })

    // The meeting point is a distinct flag pin on A's own map.
    await gotoTab(A, 'map')
    await expect(A.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(A.locator('.rzv-pin')).toBeVisible()

    // B receives the rendezvous over the relay — the card with its own countdown.
    await gotoTab(B, 'circle')
    await expect(B.locator('#rzv-countdown')).toBeVisible({ timeout: 15_000 })

    // The countdown is LIVE: read it, wait a couple of ticks, it must have moved.
    const readCountdown = (): Promise<string | null> => B.locator('#rzv-countdown').textContent()
    const first = (await readCountdown())?.trim()
    expect(first, 'a countdown should render').toBeTruthy()
    await B.waitForTimeout(2_200) // at least two 1 s ticks
    const second = (await readCountdown())?.trim()
    expect(second, 'the countdown should tick down, not sit still').not.toBe(first)

    // And B sees the same meeting-point pin on the map.
    await gotoTab(B, 'map')
    await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
    await expect(B.locator('.rzv-pin')).toBeVisible()
  })
})
