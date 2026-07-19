import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab } from './fixtures'

test.describe('fixed signal boundary', () => {
  test('group coordination has only fixed actions before and after inbound traffic', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await gotoTab(B, 'chat')
    await expect(B.locator('.chat-card textarea, .chat-card input')).toHaveCount(0)
    await expect(B.locator('[data-action="check-in"]')).toHaveText('Check in')
    await expect(B.locator('[data-action="group-signal"][data-signal="on_my_way"]')).toHaveText('On my way')

    await sendBuzz(A)
    await expect(B.locator('.buzz-banner')).toContainText('On my way')
    await expect(B.locator('#chat-thread')).toContainText('On my way')
    await expect(B.locator('.chat-card textarea, .chat-card input')).toHaveCount(0)
  })
})
