import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, moveAndReshare, sendSOS, gotoTab, memberPill } from './fixtures'

test.describe('breadcrumb trail — where they\'d been before the alert', () => {
  test('A moves, then SOS → B receives the trail alongside the alert', async ({ browser }) => {
    // A controls its own clock so three fixes can pass the 60 s crumb-spacing
    // gate without the test taking minutes of wall time.
    const A = await newPerson(browser, undefined, { clock: true })
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A walks: three distinct fixes, minutes apart on A's clock. Each lands in
    // the on-device buffer only — nothing is disclosed while walking.
    await startSharing(A)
    await A.clock.fastForward(2 * 60 * 1000)
    await moveAndReshare(A, { latitude: 51.5102, longitude: -0.132 })
    await A.clock.fastForward(2 * 60 * 1000)
    await moveAndReshare(A, { latitude: 51.5138, longitude: -0.136 })

    // The trigger discloses the buffer: help + trail ride out together.
    await sendSOS(A)

    await gotoTab(B, 'circle')
    await expect(memberPill(B, /help/)).toBeVisible()
    await expect(B.locator('.member .when', { hasText: 'recent trail on the map' })).toBeVisible()
  })
})
