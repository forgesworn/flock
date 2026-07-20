// Editing a dropped pin from the map: long-press one of your OWN pins → the
// placement bar reopens in move mode, offering Cancel, 🗑 Remove AND a usable
// "Move pin here" — all three inside the viewport (a width:100% button once
// shoved the primary action off-screen; see .pin-edit-del in styles.css).
import { test, expect, newPerson, createCircle, gotoTab } from './fixtures'

test('long-press own pin → move mode with remove + a usable Move pin here', async ({ browser }) => {
  const page = await newPerson(browser)
  await page.setViewportSize({ width: 390, height: 844 })
  await createCircle(page, { name: 'EditFlow' })
  await gotoTab(page, 'home')

  // Drop a pin.
  await page.locator('.pins-fab').click()
  await page.click('[data-action="pin-place-start"]')
  await expect(page.locator('.draft-pin')).toBeVisible()
  await page.click('[data-action="pin-drop"]')
  await expect(page.locator('.drop-pin.mine')).toBeVisible()

  // Long-press it (hold > the 450ms threshold, without moving).
  const pin = page.locator('.drop-pin.mine')
  const box = await pin.boundingBox()
  if (!box) throw new Error('no pin box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(650)
  await page.mouse.up()

  // Move mode: placing, with the remove button…
  await expect(page.locator('.home-shell.placing')).toBeVisible()
  await expect(page.locator('[data-action="pin-remove-editing"]')).toBeVisible()

  // …and the primary action present, labelled for moving, and fully on-screen.
  const move = page.locator('[data-action="pin-drop"]')
  await expect(move).toBeVisible()
  await expect(move).toHaveText(/Move pin here/)
  const mbox = await move.boundingBox()
  const vp = page.viewportSize()
  if (!mbox || !vp) throw new Error('no box')
  expect(mbox.x + mbox.width).toBeLessThanOrEqual(vp.width + 1)
  expect(mbox.y + mbox.height).toBeLessThanOrEqual(vp.height + 1)

  // Confirming closes placement and the pin remains (moved in place, same id).
  await move.click()
  await expect(page.locator('.home-shell.placing')).toHaveCount(0)
  await expect(page.locator('.drop-pin.mine')).toBeVisible()
  await expect(page.locator('.pins-fab .fab-count')).toHaveText('1') // moved, not duplicated

  // Removing from move mode deletes it.
  const box2 = await page.locator('.drop-pin.mine').boundingBox()
  if (!box2) throw new Error('no pin box after move')
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(650)
  await page.mouse.up()
  await expect(page.locator('.home-shell.placing')).toBeVisible()
  await page.click('[data-action="pin-remove-editing"]')
  await expect(page.locator('.home-shell.placing')).toHaveCount(0)
  await expect(page.locator('.drop-pin')).toHaveCount(0)
  await expect(page.locator('.pins-fab .fab-count')).toHaveCount(0)
})
