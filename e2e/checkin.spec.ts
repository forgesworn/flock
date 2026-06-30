import { test, expect, newPerson, createCircle, inviteCode, joinByCode, armCheckin, gotoTab, memberPill } from './fixtures'

test.describe('check-in — dead-man\'s-switch', () => {
  test('A arms a check-in → B sees A checked in', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await armCheckin(A, 900) // 15-minute cadence — broadcasts an "I'm OK"
    await gotoTab(B, 'circle')
    await expect(memberPill(B, /checked in/)).toBeVisible()
  })

  test('A misses the window → B\'s dead-man\'s-switch fires (missed)', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser, undefined, { clock: true }) // B controls its own clock
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await armCheckin(A, 900)
    await gotoTab(B, 'circle')
    await expect(memberPill(B, /checked in/)).toBeVisible()

    // 22 minutes pass on B with no further check-in from A — past the
    // 15-min cadence + 5-min grace. The absence of action raises the alarm.
    await B.clock.fastForward(22 * 60 * 1000)

    await expect(memberPill(B, /missed/)).toBeVisible()
  })
})
