// The redesigned pins flow: a bottom-right FAB opens a clean list sheet; "Drop a
// pin" enters a placement mode with a fixed crosshair over the map's centre that
// the user positions by dragging the map, a single kind picker, then Drop. Fixed
// vocabulary only — no free text — so the no-free-form property still holds.
import { test, expect, newPerson, createCircle, gotoTab } from './fixtures'

test('pins: FAB → sheet → drag-to-aim placement → listed', async ({ browser }) => {
  const page = await newPerson(browser)
  await page.setViewportSize({ width: 390, height: 844 }) // a real phone form factor
  await createCircle(page, { name: 'Weekend crew' })
  await gotoTab(page, 'home')

  // The pins button floats bottom-right, off the crowded top overlay, with no
  // count until a pin exists.
  const fab = page.locator('.pins-fab')
  await expect(fab).toBeVisible()
  await expect(page.locator('.pins-fab .fab-count')).toHaveCount(0)

  // Open the list sheet — empty, offering a single "Drop a pin".
  await fab.click()
  await expect(page.locator('#pins-sheet')).toBeVisible()
  await expect(page.locator('.pin-empty')).toBeVisible()
  await expect(page.locator('.pin-drop-cta')).toBeVisible()

  // Enter placement: a crosshair over the map centre + an aim bar; the shell
  // enters its focused "placing" state.
  await page.click('[data-action="pin-place-start"]')
  await expect(page.locator('#pins-sheet')).toHaveCount(0) // the list sheet stepped aside
  await expect(page.locator('.place-crosshair')).toBeVisible()
  await expect(page.locator('#pin-place-bar')).toBeVisible()
  await expect(page.locator('.home-shell.placing')).toBeVisible()

  // Pick a kind (single row, no duplicate "drop here / place on map" chips), then
  // drop at wherever the crosshair — the map's centre — is now.
  await page.click('[data-action="pin-kind"][data-kind="car"]')
  await expect(page.locator('.pin-kind.on')).toHaveText(/Car/i)
  await page.click('[data-action="pin-drop"]')
  await expect(page.locator('.place-crosshair')).toHaveCount(0) // placement closed

  // The FAB now carries a count, and the pin is listed and navigable.
  await expect(page.locator('.pins-fab .fab-count')).toHaveText('1')
  await page.locator('.pins-fab').click()
  await expect(page.locator('.pin-row')).toHaveCount(1)
  await expect(page.locator('.pin-row .pin-nav')).toContainText('Car')

  // Remove it — the list empties in place and the badge clears.
  await page.click('.pin-row [data-action="remove-pin"]')
  await expect(page.locator('.pin-row')).toHaveCount(0)
  await expect(page.locator('.pin-empty')).toBeVisible()
  await page.click('[data-action="pins-close"]')
  await expect(page.locator('.pins-fab .fab-count')).toHaveCount(0)
})

test('pins: Cancel leaves placement without dropping', async ({ browser }) => {
  const page = await newPerson(browser)
  await page.setViewportSize({ width: 390, height: 844 })
  await createCircle(page, { name: 'Trip' })
  await gotoTab(page, 'home')

  await page.locator('.pins-fab').click()
  await page.click('[data-action="pin-place-start"]')
  await expect(page.locator('.place-crosshair')).toBeVisible()
  await page.click('[data-action="pin-cancel"]')
  await expect(page.locator('.place-crosshair')).toHaveCount(0)
  await expect(page.locator('.home-shell.placing')).toHaveCount(0)
  await expect(page.locator('.pins-fab .fab-count')).toHaveCount(0) // nothing dropped
})
