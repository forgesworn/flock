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

  test('custom cadence: A arms a 20-minute check-in → B sees A checked in', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Not one of the presets — typed into the custom minutes field.
    await gotoTab(A, 'home')
    await A.click('[data-action="arm-menu"]')
    await A.fill('#custom-interval-mins', '20')
    await A.click('[data-action="arm-custom"]')
    await expect(A.locator('.checkin-armed')).toContainText('Next check-in in 20m')

    await gotoTab(B, 'circle')
    await expect(memberPill(B, /checked in/)).toBeVisible()
  })

  test('self-reminder: A is nudged due-soon, then overdue — before the circle is alarmed', async ({ browser }) => {
    const A = await newPerson(browser, undefined, { clock: true })
    await createCircle(A, { name: 'Solo', mode: 'family' })
    await armCheckin(A, 900) // due at 15 min; reminder window opens 10 min before

    await A.clock.fastForward(6 * 60 * 1000) // 6 min in → inside the window
    await expect(A.locator('.checkin-armed')).toContainText('Due soon')

    await A.clock.fastForward(10 * 60 * 1000) // 16 min in → past due, within grace
    await expect(A.locator('.checkin-armed')).toContainText('Overdue — check in now')
  })

  test('A misses → B says "I\'ve got this" → C sees it\'s being handled (3 people)', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser, undefined, { clock: true })
    const C = await newPerson(browser, undefined, { clock: true })
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await joinByCode(C, code)

    await armCheckin(A, 900)
    await gotoTab(B, 'circle')
    await gotoTab(C, 'circle')
    await expect(memberPill(B, /checked in/)).toBeVisible()
    await expect(memberPill(C, /checked in/)).toBeVisible()

    // Both watchers pass the 15-min cadence + 5-min grace with no word from A.
    await B.clock.fastForward(22 * 60 * 1000)
    await C.clock.fastForward(22 * 60 * 1000)
    await expect(memberPill(B, /missed/)).toBeVisible()
    await expect(memberPill(C, /missed/)).toBeVisible()

    // B steps up — peer-to-peer escalation, no monitoring centre. The ack rides
    // the same gift-wrapped path as every other signal.
    await B.click('[data-action="ack-checkin"]')
    await expect(memberPill(B, /You on it/)).toBeVisible()

    // The assertion that matters is on the OTHER watcher's screen: C sees B has it.
    await expect(memberPill(C, /on it/)).toBeVisible()
    await expect(C.locator('[data-action="ack-checkin"]')).toHaveCount(0)
  })
})
