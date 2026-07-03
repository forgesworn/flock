import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendSOS, gotoTab, openAdvanced, memberPill, myPubkey } from './fixtures'
import type { Page } from '@playwright/test'

/** Precisions of every cached pin held for `member`, straight from local state. */
async function cachedPrecisions(page: Page, member: string): Promise<number[]> {
  return page.evaluate((pk) => {
    const s = JSON.parse(localStorage.getItem('flock:v1') as string)
    return (Object.values(s.presence ?? {}) as { member: string; precision: number }[][])
      .flat().filter((b) => b.member === pk).map((b) => b.precision)
  }, member)
}

test.describe('truthful SOS states (audit Slice 11)', () => {
  // The orb must never claim "Help sent" when nothing went out. Break every relay,
  // SOS, and the failure must be a PERSISTENT retry state — not a vanishing toast.
  test("a failed SOS shows 'Help didn't send', persistently", async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    await openAdvanced(A)
    await A.fill('#relay', 'wss://127.0.0.1:9')
    await A.click('[data-action="save-relay"]')
    // Let the (failing) resubscription settle: a re-render mid-hold replaces the
    // SOS node between pointerdown and pointerup and the hold never fires.
    await A.waitForTimeout(2000)

    await sendSOS(A)
    await expect(A.locator('.orb-wrap.state-alert')).toContainText("Help didn't send")
    // Outlives any toast (2.8 s) — still telling the truth seconds later.
    await A.waitForTimeout(3500)
    await expect(A.locator('.orb-wrap.state-alert')).toContainText("Help didn't send")
  })

  // Receiver sees WHO needs help; "I'm safe now" stands the circle down; a covert
  // long-press stand-down calms the coerced screen but keeps the circle alarmed.
  test("receiver sees '[name] needs help'; stand-down clears it; a coerced stand-down doesn't", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A raises help: A sees the sender view, B sees who needs help.
    await sendSOS(A)
    await expect(A.locator('.orb-wrap.state-alert')).toContainText('Help sent')
    await gotoTab(B, 'home')
    await expect(B.locator('.orb-wrap.state-alert')).toContainText('needs help')

    // A is fine: one tap stands the whole circle down.
    await A.click('[data-action="im-safe"]')
    await expect(A.locator('.orb-wrap.state-alert')).toHaveCount(0)
    await expect(B.locator('.orb-wrap.state-alert')).toHaveCount(0)

    // The emergency over, A's cached pin degrades from SOS-precise (11) to the
    // ambient coarse cell — on B's device AND on A's own screen.
    const aPk = await myPubkey(A)
    for (const device of [A, B]) {
      const precisions = await cachedPrecisions(device, aPk)
      expect(precisions.length).toBeGreaterThan(0)
      expect(Math.max(...precisions)).toBeLessThanOrEqual(6)
    }

    // Round two — but this time A is COERCED into "tell them you're fine".
    await sendSOS(A)
    await expect(B.locator('.orb-wrap.state-alert')).toContainText('needs help')
    await A.locator('[data-action="im-safe"]').click({ delay: 1300 })
    // A's screen is visibly identical to a genuine stand-down…
    await expect(A.locator('.orb-wrap.state-alert')).toHaveCount(0)
    // …but the circle STAYS alarmed.
    await B.waitForTimeout(2500)
    await expect(B.locator('.orb-wrap.state-alert')).toContainText('needs help')
    await gotoTab(B, 'circle')
    await expect(memberPill(B, 'help')).toBeVisible()
  })
})
