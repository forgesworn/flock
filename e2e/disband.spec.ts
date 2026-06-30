import { test, expect, newPerson, createCircle, inviteCode, joinByCode, disbandCircle } from './fixtures'

test.describe('disband — end a circle for everyone', () => {
  test('A disbands → B receives the tombstone and drops the circle', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code) // B's only circle

    await disbandCircle(A)

    // B's app wipes the circle's seed and, with no circles left, returns to onboarding.
    await expect(B.getByRole('button', { name: 'Create a circle' })).toBeVisible()
  })
})
