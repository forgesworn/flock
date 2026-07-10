import { test, expect, acceptLegal } from './fixtures'

// The iPhone join gap (field report 2026-07-09): a camera-app scan of an
// invite QR opens the BROWSER, never the installed app — iOS gives a
// home-screen web app no way to claim a link, and the two keep separate
// storage. So (a) a phone-browser join must offer the way across to the
// installed app, and (b) the app itself must scan QRs from INSIDE, so the
// easy in-person join never leaves it.
test.describe('joining without the Safari trap', () => {
  test('a join link in a phone browser offers the app handoff', async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
    })
    const page = await ctx.newPage()
    // A syntactically-valid invite decodes locally — no relay round-trip needed.
    const code = Buffer.from(JSON.stringify({ v: 1, id: 'e2e-handoff', s: 'a'.repeat(64), n: 'Handoff', m: 'nightout' })).toString('base64')
    await page.goto(`/#join=${encodeURIComponent(code)}`)
    await acceptLegal(page)

    // The join-name screen carries the rescue: separate-identity warning + copy.
    await expect(page.locator('h1')).toContainText('Joining Handoff')
    await expect(page.getByText(/own separate identity/i)).toBeVisible()
    await expect(page.locator('[data-action="copy-join-invite"]')).toBeVisible()
    await ctx.close()
  })

  test('the join screen scans from inside the app, and degrades honestly without a camera', async ({ page }) => {
    await page.goto('/')
    await acceptLegal(page)
    await page.click('[data-action="join"]')
    await expect(page.locator('[data-action="scan-join"]')).toBeVisible()
    await page.click('[data-action="scan-join"]')

    // The scanner overlay mounts; headless Chromium has no camera permission,
    // so the HONEST fallback shows — the words path is never a dead end.
    const shell = page.locator('#qrscan-shell')
    await expect(shell).toBeVisible()
    await expect(shell.locator('#qrscan-status')).toContainText(/camera unavailable/i)

    // Cancel tears it down completely.
    await shell.locator('#qrscan-cancel').click()
    await expect(page.locator('#qrscan-shell')).toHaveCount(0)
  })
})
