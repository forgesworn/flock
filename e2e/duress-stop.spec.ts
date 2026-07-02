import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, memberPill } from './fixtures'

test.describe('coerced stop-sharing — silent alarm (FLOCK §6.1)', () => {
  // The three actions a coercer plausibly forces ("turn it off") get a covert
  // long-press variant: the screen does exactly what a normal tap does, but the
  // circle is silently alarmed. Proven here on stop-sharing, the archetype.
  test('a normal stop stays silent; a long-press stop alarms B while A stays calm', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A normal tap-stop is just a stop — nothing reaches B.
    await startSharing(A)
    await gotoTab(A, 'home')
    await A.click('[data-action="toggle-share"]')
    await B.waitForTimeout(3000)
    await gotoTab(B, 'circle')
    await expect(B.locator('.member .pill', { hasText: 'help' })).toHaveCount(0)

    // A coerced stop: hold the same button ~1.3 s. Visibly identical to the tap…
    await startSharing(A)
    await A.locator('[data-action="toggle-share"]').click({ delay: 1300 })
    // …but the silent alarm reaches B…
    await expect(memberPill(B, 'help')).toBeVisible()
    // …while NOTHING surfaces on A's own screen — its echo is suppressed, because
    // the coercer may be looking at it.
    await gotoTab(A, 'circle')
    await A.waitForTimeout(1500) // give the relay echo time to arrive (and be dropped)
    await expect(A.locator('.member .pill', { hasText: 'help' })).toHaveCount(0)
  })
})
