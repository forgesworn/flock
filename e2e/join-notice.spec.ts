import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab } from './fixtures'

test.describe('join notice — a new phone on the roster is never silent (audit Slice 7)', () => {
  // Seed possession = membership, so a photographed QR or synced clipboard grants
  // an INVISIBLE member. The notice makes every unexpected addition loud — while
  // the roster replaying to a fresh joiner stays quiet (that's not news to them).
  test('B joining is news to A; the roster replaying to B is not; "Got it" clears it', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    // A's buzz becomes stored relay history — the roster B will replay on joining.
    await sendBuzz(A, 'setup done')

    const code = await inviteCode(A)
    await joinByCode(B, code)
    // B discovers A via replay moments after joining — expected, not news.
    await gotoTab(B, 'circle')
    await expect(B.locator('.member')).toHaveCount(2)
    await expect(B.locator('.new-member-notice')).toHaveCount(0)

    // B's first signal reaches A: THAT is news — banner + a "new" badge on the row.
    await sendBuzz(B, 'hello')
    await gotoTab(A, 'circle')
    await expect(A.locator('.new-member-notice')).toBeVisible()
    await expect(A.locator('.member.unseen .pill.new')).toBeVisible()

    // Acknowledge → cleared, and it STAYS cleared on B's next signal.
    await A.click('[data-action="ack-new-members"]')
    await expect(A.locator('.new-member-notice')).toHaveCount(0)
    await sendBuzz(B, 'again')
    await expect(A.locator('.buzz-banner')).toBeVisible()
    await expect(A.locator('.new-member-notice')).toHaveCount(0)
  })
})
