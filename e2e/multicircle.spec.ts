import { test, expect, newPerson, createCircle, inviteCode, joinByCode, addCircle, sendSOS, gotoTab } from './fixtures'

test.describe('multi-circle', () => {
  // A person can be in many circles at once. An alert from one must surface even
  // while they're focused on another (the multi-inbox subscription model).
  test('an SOS in a background circle still surfaces', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)

    await createCircle(A, { name: 'Family', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code) // B is in Family with A

    // B opens a second, unrelated circle and focuses on it.
    await addCircle(B)
    await createCircle(B, { name: 'Trip', mode: 'family' })
    await gotoTab(B, 'home')
    await expect(B.locator('.circle-chip.on')).toContainText('Trip')

    // A raises an SOS in Family while B is looking at Trip.
    await sendSOS(A)

    // The alert surfaces globally on B's Home orb, regardless of focus.
    await gotoTab(B, 'home')
    await expect(B.locator('.orb-wrap.state-alert')).toBeVisible()
  })

  // My own SOS must survive a circle switch: the alerted circle is held at the
  // front of the chip row and flagged, the orb still says where help went, and
  // stand-down stays one tap away from anywhere.
  test('my SOS holds its circle at the top while I browse another', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)

    // Trip first, so Family sits SECOND in stored order — the hoist is real.
    await createCircle(A, { name: 'Trip', mode: 'family' })
    await addCircle(A)
    await createCircle(A, { name: 'Family', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code) // B is in Family with A

    // A raises an SOS in Family, then browses away to Trip.
    await sendSOS(A)
    await expect(A.locator('.orb-wrap.state-alert')).toContainText('Help sent')
    await A.locator('.circle-chip', { hasText: 'Trip' }).click()

    // The SOS state survives the switch, names its circle, and Family is
    // hoisted to the front of the row with the alert flag.
    await expect(A.locator('.orb-wrap.state-alert')).toContainText('Help sent')
    await expect(A.locator('.orb-sub')).toContainText('Family')
    await expect(A.locator('.circle-chip').first()).toContainText('Family')
    await expect(A.locator('.circle-chip.alert')).toContainText('Family')

    // Stand down from HERE — the whole circle calms, and the flag clears.
    await gotoTab(B, 'home')
    await expect(B.locator('.orb-wrap.state-alert')).toContainText('needs help')
    await A.click('[data-action="im-safe"]')
    await expect(A.locator('.orb-wrap.state-alert')).toHaveCount(0)
    await expect(A.locator('.circle-chip.alert')).toHaveCount(0)
    await expect(B.locator('.orb-wrap.state-alert')).toHaveCount(0)
  })
})
