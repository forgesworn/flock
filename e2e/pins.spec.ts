// The pins flow: a bottom-right FAB opens a clean list sheet; "Drop a pin" enters
// placement mode with a finger-DRAGGABLE pin on the map (starts at the map centre —
// where you've already aimed the view; grab it, or pan the map, to fine-tune, or tap
// "locate me" first to pin your own spot), a single kind picker, then Drop — which
// lands it at full precision. Fixed vocabulary only, so the no-free-form property
// still holds. (The drag gesture itself is verified on-device.)
import { test, expect, newPerson, createCircle, inviteCode, joinByCode, gotoTab } from './fixtures'

test('pins: FAB → sheet → draggable-pin placement → listed', async ({ browser }) => {
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

  // Enter placement: a draggable pin appears on the map + an aim bar; the shell
  // enters its focused "placing" state.
  await page.click('[data-action="pin-place-start"]')
  await expect(page.locator('#pins-sheet')).toHaveCount(0) // the list sheet stepped aside
  await expect(page.locator('.draft-pin')).toBeVisible() // the finger-draggable pin
  await expect(page.locator('#pin-place-bar')).toBeVisible()
  await expect(page.locator('.home-shell.placing')).toBeVisible()
  // The draggable pin wears the default kind's icon (Meet 📍) — you see what drops.
  await expect(page.locator('.draft-pin .flag')).toHaveText('📍')

  // Pick a kind (single row, no duplicate "drop here / place on map" chips): the
  // chip highlights AND the draggable pin on the map swaps to that icon live, then
  // drop the pin exactly where it sits.
  await page.click('[data-action="pin-kind"][data-kind="car"]')
  await expect(page.locator('.pin-kind.on')).toHaveText(/Car/i)
  await expect(page.locator('.draft-pin .flag')).toHaveText('🚗') // map preview updated
  await page.click('[data-action="pin-drop"]')
  await expect(page.locator('.draft-pin')).toHaveCount(0) // placement closed

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

test('pins: edit a pin changes its icon in place', async ({ browser }) => {
  const page = await newPerson(browser)
  await page.setViewportSize({ width: 390, height: 844 })
  await createCircle(page, { name: 'Edit crew' })
  await gotoTab(page, 'home')

  // Drop a Car pin.
  await page.locator('.pins-fab').click()
  await page.click('[data-action="pin-place-start"]')
  await page.click('[data-action="pin-kind"][data-kind="car"]')
  await page.click('[data-action="pin-drop"]')
  await page.locator('.pins-fab').click()
  await expect(page.locator('.pin-row .pin-nav')).toContainText('Car')

  // Edit it → the same aim bar opens, seeded with the pin's current icon selected
  // and its glyph on the draggable pin. Switch the icon to Parking and save.
  await page.click('.pin-row [data-action="edit-pin"]')
  await expect(page.locator('#pin-place-bar')).toBeVisible()
  await expect(page.locator('.pin-kind.on')).toHaveText(/Car/i)
  await expect(page.locator('.draft-pin .flag')).toHaveText('🚗')
  await page.click('[data-action="pin-kind"][data-kind="parking"]')
  await expect(page.locator('.draft-pin .flag')).toHaveText('🅿️') // map preview swapped live
  await page.click('[data-action="pin-drop"]') // "Save pin"
  await expect(page.locator('.draft-pin')).toHaveCount(0)

  // One pin still (edited in place, not a second drop), now showing the new icon.
  await page.locator('.pins-fab').click()
  await expect(page.locator('.pin-row')).toHaveCount(1)
  await expect(page.locator('.pin-row .pin-nav')).toContainText('Parking')
  await expect(page.locator('.pins-fab .fab-count')).toHaveText('1')
})

test('pins: a pin one member drops arrives on every other member', async ({ browser }) => {
  // The whole point of a shared pin: drop it once and the circle sees it. A's drop
  // is gift-wrapped to the circle inbox (publishSignal) and lands on every member
  // via onSignalWrap → decryptPin → landPin. Proven here over the live relay, with B
  // sharing NO location of its own — a pin is a place, not a person.
  const A = await newPerson(browser)
  const B = await newPerson(browser)
  await A.setViewportSize({ width: 390, height: 844 })
  await B.setViewportSize({ width: 390, height: 844 })
  await createCircle(A, { name: 'Road trip' })
  const code = await inviteCode(A)
  await joinByCode(B, code)

  // A drops a Car pin.
  await gotoTab(A, 'home')
  await A.locator('.pins-fab').click()
  await A.click('[data-action="pin-place-start"]')
  await A.click('[data-action="pin-kind"][data-kind="car"]')
  await A.click('[data-action="pin-drop"]')
  await expect(A.locator('.pins-fab .fab-count')).toHaveText('1')

  // B — who shared nothing — receives it: the FAB counts it, it draws on B's map as
  // SOMEONE ELSE'S pin (.drop-pin, never .mine), and it's listed as A's Car.
  await gotoTab(B, 'home')
  await expect(B.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
  await expect(B.locator('.pins-fab .fab-count')).toHaveText('1', { timeout: 30_000 })
  await expect(B.locator('.drop-pin')).toBeVisible()
  await expect(B.locator('.drop-pin.mine')).toHaveCount(0) // it's A's pin, not B's
  await B.locator('.pins-fab').click()
  await expect(B.locator('.pin-row .pin-nav')).toContainText('Car')
  await B.click('[data-action="pins-close"]')

  // A removal propagates the same way (a tombstone the receiver applies): A clears
  // the pin and it disappears from B's map and count too — no stale pin left behind.
  await A.locator('.pins-fab').click()
  await A.click('.pin-row [data-action="remove-pin"]')
  await expect(A.locator('.pin-row')).toHaveCount(0)
  await expect(B.locator('.drop-pin')).toHaveCount(0, { timeout: 30_000 })
  await expect(B.locator('.pins-fab .fab-count')).toHaveCount(0)
})

test('pins: Cancel leaves placement without dropping', async ({ browser }) => {
  const page = await newPerson(browser)
  await page.setViewportSize({ width: 390, height: 844 })
  await createCircle(page, { name: 'Trip' })
  await gotoTab(page, 'home')

  await page.locator('.pins-fab').click()
  await page.click('[data-action="pin-place-start"]')
  await expect(page.locator('.draft-pin')).toBeVisible()
  await page.click('[data-action="pin-cancel"]')
  await expect(page.locator('.draft-pin')).toHaveCount(0)
  await expect(page.locator('.home-shell.placing')).toHaveCount(0)
  await expect(page.locator('.pins-fab .fab-count')).toHaveCount(0) // nothing dropped
})
