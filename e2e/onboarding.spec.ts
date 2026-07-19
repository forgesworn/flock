import { test, expect, newPerson, createCircle, gotoTab } from './fixtures'
import { BASE_URL } from '../playwright.config'

// Single-person UI contract: plain language and the "inviting is
// front-and-centre" landing. No relay needed.
test.describe('onboarding & circle setup', () => {
  test('adult-only terms must be acknowledged before flock opens', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, locale: 'en-GB' })
    const page = await context.newPage()
    await page.goto('/')

    const enter = page.getByRole('button', { name: 'Enter flock' })
    await expect(enter).toBeDisabled()
    await page.getByLabel('I am 18 or older').check()
    await expect(enter).toBeDisabled()
    await page.getByLabel('I will only use flock with consenting adults').check()
    await expect(enter).toBeEnabled()
    await enter.click()
    await expect(page.getByRole('button', { name: 'Create a circle' })).toBeVisible()
    await context.close()
  })

  test('creating a circle lands on Circle with invite front-and-centre', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    // The 👋 lead card + the copy-invite control are both right there.
    await expect(A.locator('.invite-lead')).toBeVisible()
    await expect(A.locator('[data-action="copy-invite"]')).toBeVisible()
    await expect(A.locator('[data-action="send-invite"]')).toBeVisible()
  })

  test('lifetime: Today carries a TTL chip; Ongoing does not', async ({ browser }) => {
    const today = await newPerson(browser)
    await createCircle(today, { name: 'Sat night', ttl: 'today' })
    await gotoTab(today, 'home')
    await expect(today.locator('.circle-chip.on .ttl')).toBeVisible()

    const ongoing = await newPerson(browser)
    await createCircle(ongoing, { name: 'Mallorca trip', ttl: 'ongoing' })
    await gotoTab(ongoing, 'home')
    await expect(ongoing.locator('.circle-chip.on')).toBeVisible()
    await expect(ongoing.locator('.circle-chip.on .ttl')).toHaveCount(0)
  })

  test('a lone member is nudged to invite people (Circle tab lead card)', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    // createCircle already lands on Circle — alone, so the invite lead auto-opens.
    await expect(A.locator('.invite-lead')).toBeVisible()
  })

  test('the MVP controls: share toggle on Home, precision slider on Circle, quick actions on Chat', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'Mallorca trip' })
    await gotoTab(A, 'home')
    await expect(A.locator('[data-action="toggle-share"]')).toBeVisible()
    await expect(A.locator('[data-action="toggle-share"]')).toHaveAttribute('aria-pressed', 'false')
    await gotoTab(A, 'circle')
    await expect(A.locator('#share-precision')).toBeVisible()
    await expect(A.locator('#share-precision')).toHaveValue('6')
    await gotoTab(A, 'chat')
    await expect(A.locator('[data-action="check-in"]')).toBeVisible()
    await expect(A.locator('[data-action="group-signal"][data-signal="on_my_way"]')).toBeVisible()
  })
})
