import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab } from './fixtures'

test.describe('typing survives inbound re-renders (audit follow-up)', () => {
  // The input-wipe bug: render-on-state rebuilds the DOM whenever a signal
  // arrives, and whatever you were mid-typing vanished — then the next tap acted
  // on the emptied field. Reproduce the original failure exactly: B is mid-typing
  // a buzz reason when A's buzz lands and re-renders B's screen.
  test("B's half-typed buzz reason survives A's incoming buzz", async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // B starts typing a chat message — with real keystrokes, focus in the field.
    await gotoTab(B, 'chat')
    await B.locator('#chat-input').pressSequentially('meet at the corner', { delay: 20 })

    // A's buzz lands on B mid-thought and re-renders B's whole screen.
    await sendBuzz(A, 'where are you?')
    await expect(B.locator('.buzz-banner')).toBeVisible()

    // B's typing is still there — value AND focus — and sending it works.
    await expect(B.locator('#chat-input')).toHaveValue('meet at the corner')
    await B.locator('#chat-input').press('End')
    await B.click('[data-action="chat-send"]')
    await expect(A.locator('.buzz-banner')).toContainText('meet at the corner')
  })
})
