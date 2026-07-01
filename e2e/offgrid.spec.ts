import { test, expect, newPerson, createCircle, inviteCode, joinByCode, takeBreak, startSharing, gotoTab, memberPill } from './fixtures'

test.describe('off-grid — a planned, pre-announced silence', () => {
  test('take a break A→B — B sees A on a break; A comes back and it clears', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'nightout' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await takeBreak(A, 'at the cinema')

    // A's own orb reflects the planned darkness.
    await gotoTab(A, 'home')
    await expect(A.locator('.orb-wrap.state-dark')).toContainText('Taking a break')

    // B is told it's planned — A shows "on a break", not a missed-check-in alarm.
    await gotoTab(B, 'circle')
    await expect(memberPill(B, /on a break/)).toBeVisible()

    // A comes back early; B's break pill clears.
    await gotoTab(A, 'home')
    await A.click('[data-action="come-back"]')
    await gotoTab(B, 'circle')
    await expect(memberPill(B, /on a break/)).toHaveCount(0)
  })

  // Minimal-footprint north star (Phase H): the GPS watch must not keep burning when
  // it can't do anything. A deliberate break suspends sampling; coming back resumes it.
  test('sampling suspends during a break and resumes on return', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Night', mode: 'nightout' })
    const sampling = (): Promise<boolean> =>
      A.evaluate(() => (window as unknown as { flockSampling?: () => boolean }).flockSampling?.() ?? false)

    await startSharing(A)
    await expect.poll(sampling, { timeout: 10_000 }).toBe(true) // GPS watch on while sharing

    await takeBreak(A) // "take a break" → off-grid
    await expect.poll(sampling, { timeout: 10_000 }).toBe(false) // suspended for the break

    await gotoTab(A, 'home')
    await A.click('[data-action="come-back"]')
    await expect.poll(sampling, { timeout: 10_000 }).toBe(true) // resumes on return
  })
})
