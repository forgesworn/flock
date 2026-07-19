import {
  test,
  expect,
  newPerson,
  createCircle,
  inviteCode,
  joinByCode,
  startSharing,
  goPrivate,
  gotoTab,
  settle,
  joinRemoteAwait,
  sendRemoteInvite,
  quickAction,
  openDmWith,
  myPubkey,
} from './fixtures'

// Flock coordinates with a deliberately bounded vocabulary. These scenarios
// prove both delivery paths and the absence of a general-purpose composer.
test.describe('structured circle and private signals', () => {
  test('Home is the full-screen map; Signals has fixed actions and no composer', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    await gotoTab(A, 'home')
    await expect(A.locator('.home-shell')).toBeVisible()
    await expect(A.locator('.map-status')).toBeVisible()
    await expect(A.locator('.member-strip')).toBeVisible()
    // The coordination surface is its own tab — no signals card floats over Home.
    await expect(A.locator('.chat-card')).toHaveCount(0)

    await gotoTab(A, 'chat')
    await expect(A.locator('[data-action="check-in"]')).toHaveText('Check in')
    await expect(A.locator('[data-action="group-signal"][data-signal="on_my_way"]')).toHaveText('On my way')
    // Fixed actions only — there is no free-text field to type into.
    await expect(A.locator('.chat-card textarea, .chat-card input')).toHaveCount(0)
  })

  test('circle action A→everyone — B gets a banner and both activity logs update', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await quickAction(A, 'On my way')
    await expect(A.locator('#chat-thread .msg.mine')).toContainText('On my way')
    await expect(B.locator('.buzz-banner')).toContainText('On my way')
    await gotoTab(B, 'chat')
    await expect(B.locator('#chat-thread .msg')).toContainText('On my way')
  })

  test('private action A→B — fixed, encrypted to B, and recorded without a composer', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await startSharing(A)
    await startSharing(B)
    await settle(A)

    const bPk = await myPubkey(B)
    await openDmWith(A, bPk)
    await expect(A.locator('#dm-sheet')).toBeVisible()
    await expect(A.locator('#dm-sheet textarea, #dm-sheet input')).toHaveCount(0)
    await A.click('[data-action="dm-signal"][data-signal="where_are_you"]')
    await expect(A.locator('#dm-thread .msg.mine')).toContainText('Where are you?')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toContainText('Where are you?')
    await expect(banner).toContainText('just you')
    await gotoTab(B, 'you')
    await expect(B.locator('.dm-row')).toContainText('Where are you?')
    await B.locator('.dm-row').first().click()
    await expect(B.locator('#dm-thread .msg')).toContainText('Where are you?')
    await expect(B.locator('#dm-sheet textarea, #dm-sheet input')).toHaveCount(0)
  })

  test('tapping a member pin on the map opens their private signals', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await startSharing(B)
    await settle(A)
    await goPrivate(A)
    await gotoTab(A, 'home')

    const pin = A.locator('.map-pin').first()
    await expect(pin).toBeVisible()
    await pin.click()
    await expect(A.locator('#dm-sheet')).toContainText('private')
    await expect(A.locator('#dm-sheet textarea, #dm-sheet input')).toHaveCount(0)
  })

  test('cold start — a freshly invited member accepts the inviter\'s first fixed action', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const npub = await joinRemoteAwait(B)
    await sendRemoteInvite(A, npub)
    await settle(B)

    const bPk = await myPubkey(B)
    await openDmWith(A, bPk)
    await A.click('[data-action="dm-signal"][data-signal="call_me"]')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toContainText('Call me')
  })
})
