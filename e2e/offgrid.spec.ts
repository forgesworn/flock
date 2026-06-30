import { test, expect, newPerson, createCircle, inviteCode, joinByCode, takeBreak, gotoTab, memberPill } from './fixtures'

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
})
