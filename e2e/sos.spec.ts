import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendSOS, gotoTab, memberPill } from './fixtures'

// The de-risk flow: two real devices, an invite, and an SOS that crosses the
// relay. If B sees A's `help` pill, the whole transport (gift-wrap → relay →
// unwrap → decrypt → render) is proven between people.
test('SOS A→B — B sees the help pill and A joins the roster', async ({ browser }) => {
  const A = await newPerson(browser)
  const B = await newPerson(browser)

  await createCircle(A, { name: 'The Smiths', mode: 'family' })
  const code = await inviteCode(A)
  await joinByCode(B, code)

  // B starts with only themselves in the circle.
  await gotoTab(B, 'circle')
  await expect(B.locator('.member')).toHaveCount(1)

  await sendSOS(A)

  // B receives the gift-wrapped help over the relay: A appears, flagged `help`.
  await expect(memberPill(B, 'help')).toBeVisible()
  await expect(B.locator('.member')).toHaveCount(2)
})
