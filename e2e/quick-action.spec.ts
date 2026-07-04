import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, setSharePrecision, quickAction, dmComeToMe, openDmWith, myPubkey, settle, gotoTab } from './fixtures'

// Quick actions are split: group-appropriate ones (Check in, On my way) live as
// preset chips in the circle chat; person-to-person asks (Come to me, Where are
// you?, Call me) live in the PM sheet instead. See app/src/app.ts's
// GROUP_QUICK_ACTIONS / DM_QUICK_ACTIONS split.
test.describe('quick actions', () => {
  test('group chip "On my way" A→everyone — B gets the banner', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await quickAction(A, 'On my way')

    const banner = B.locator('.buzz-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('On my way')
  })

  test('PM chip "Where are you?" A→B — B gets a PRIVATE banner, not a circle-wide one', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Populate both rosters over the relay (mirrors message.spec.ts): B must
    // already know A to accept A's DM — the members-gate that stops a stranger's
    // scraped npub from spamming a private message.
    await startSharing(A)
    await startSharing(B)
    await settle(A)

    const bPk = await myPubkey(B)
    await openDmWith(A, bPk)
    await expect(A.locator('#dm-sheet')).toBeVisible()
    await A.click('[data-action="dm-preset"][data-reason="Where are you?"]')

    const banner = B.locator('.buzz-banner.private')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Where are you?')
    await expect(banner).toContainText('just you')
  })

  test('PM "Come to me" — B gets a private message AND A\'s exact spot, shared to B alone', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Populate both rosters over the relay (mirrors message.spec.ts) — B must
    // already know A to accept A's location share (the same members-gate a DM
    // uses, so a stranger's scraped npub can't spam a private "spot").
    await startSharing(A)
    await startSharing(B)
    await settle(A)

    // A's own slider stays whatever it is — the one-shot private share never
    // touches it (proven at the end).
    await setSharePrecision(A, 4)

    const bPk = await myPubkey(B)
    await openDmWith(A, bPk)
    await expect(A.locator('#dm-sheet')).toBeVisible()

    // The chip arms an inline confirm — nothing is sent until A says yes.
    await dmComeToMe(A)

    // The banner coalesces the text message and the location share into one
    // stacked private notification (Signal-style "+1") — assert on the thread
    // itself for content, the banner just for "this landed, and it's private".
    await expect(B.locator('.buzz-banner.private')).toBeVisible()

    // B's copy of the thread carries BOTH the text and a location-share bubble
    // with "See on map" — proof the exact spot arrived over B's personal inbox
    // (private), not the circle's shared beacon channel everyone else would see.
    const aPk = await myPubkey(A)
    await openDmWith(B, aPk)
    await expect(B.locator('#dm-thread .msg')).toHaveCount(2) // the text, then the location share
    await expect(B.locator('#dm-thread .msg').first()).toContainText('Come to me')
    await expect(B.locator('#dm-thread .msg').last()).toContainText('Shared their exact location')
    await expect(B.locator('#dm-thread [data-action="see-shared-location"]')).toBeVisible()

    await A.click('[data-action="dm-close"]') // close the sheet — its overlay covers the nav bar
    await gotoTab(A, 'home')
    await expect(A.locator('#share-precision')).toHaveValue('4')
  })
})
