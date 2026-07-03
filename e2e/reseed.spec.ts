import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, reseed, settle, gotoTab } from './fixtures'

test.describe('reseed — rotate the circle key', () => {
  // After a reseed, every member moves to a fresh seed (new inbox). Proof it
  // propagated: A's next signal, sent on the new key, still reaches B.
  test('A rotates the key and A\'s next buzz still reaches B', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // B buzzes A so A learns B's key — reseed is gift-wrapped to known members.
    await sendBuzz(B, 'hi')
    await gotoTab(A, 'circle')
    await expect(A.locator('.member')).toHaveCount(2)

    await reseed(A) // new seed → gift-wrapped to B → B re-subscribes to the new inbox
    await settle(B, 3000) // let B receive the reseed and resubscribe

    await sendBuzz(A, 'still with you?') // sent on the NEW inbox
    await expect(B.locator('.buzz-banner')).toContainText('still with you?') // only decryptable on the new seed
  })
})
