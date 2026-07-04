import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, setSharePrecision, gotoTab } from './fixtures'

// "Find each other" (festival mode): a deliberate, temporary step-up to
// building-level detail so a group in a crowd can walk to each other. The proof is
// on the OTHER person's screen — A's coarse "rough area" halo collapses to a bare
// pin while the boost is on (precision 8 ≈ 19 m sits below the ~30 m halo
// threshold), then returns when A stops it. The slider's base value is untouched.
const areaCount = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { flockMapView?: { memberAreaCount(): number } }).flockMapView?.memberAreaCount() ?? -1)

test.describe('find each other (festival mode)', () => {
  test('A boosts detail for the circle → B sees A sharpen, then revert; A\'s slider base is untouched', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Glastonbury' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A shares coarsely (Town, ~2.4 km) — B sees a rough-area halo.
    await setSharePrecision(A, 5)
    await startSharing(A)
    await gotoTab(B, 'map')
    await expect(B.locator('.map-pin')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => areaCount(B), { timeout: 15_000 }).toBeGreaterThan(0)

    // A turns on "Find each other" — the boost re-emits at building level (~19 m),
    // which is below the halo-draw threshold, so B's halo collapses to a bare pin.
    await gotoTab(A, 'home')
    await A.click('[data-action="festival-start"][data-hours="3"]')
    await expect(A.locator('.festival-on')).toBeVisible()
    await expect.poll(() => areaCount(B), { timeout: 20_000 }).toBe(0)
    await expect(B.locator('.map-pin')).toBeVisible() // still on the map — just sharper

    // The boost never rewrites the base: the slider still reads Town (5), with a
    // note explaining the temporary step-up.
    await expect(A.locator('#share-precision')).toHaveValue('5')
    await expect(A.locator('#precision-note')).toContainText('Find each other')

    // Stop it early → A drops back to Town → B's rough-area halo returns.
    await A.click('[data-action="festival-stop"]')
    await expect.poll(() => areaCount(B), { timeout: 20_000 }).toBeGreaterThan(0)
  })

  // FLOCK §6 invariant 1: an Exact-spot beacon is wire-indistinguishable from any
  // other — we can never say WHY someone jumped that fine (festival? "Come to
  // me"? their own slider?). But a sudden, unexplained jump is exactly what read
  // as alarming/confusing in the field ("now on exact spot", no context). B should
  // get a plain heads-up that A's detail jumped, without guessing a reason.
  test('B gets a heads-up when A\'s detail suddenly jumps to Exact spot', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Glastonbury' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await setSharePrecision(A, 4) // City — well below the jump threshold
    await startSharing(A)
    await gotoTab(B, 'map')
    await expect(B.locator('.map-pin')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => areaCount(B), { timeout: 15_000 }).toBeGreaterThan(0) // B has seen A's coarse baseline

    await gotoTab(A, 'home')
    await A.click('[data-action="festival-start"][data-hours="3"]')
    await expect(B.locator('#toast')).toContainText('jumped to Exact spot', { timeout: 20_000 })
  })
})
