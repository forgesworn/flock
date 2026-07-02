import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab, openAdvanced } from './fixtures'

test.describe('backup & restore — survive losing the device', () => {
  // The worst user story the audit found: reset (or lose) your phone and every
  // circle is gone forever. The loop that closes it: back up → wipe → restore →
  // the circle still works, proven by live traffic from the other member.
  test('A backs up, wipes the device, restores — and still hears B', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A exports an encrypted backup code (copied to the clipboard).
    await gotoTab(A, 'you')
    await A.fill('#backup-pass', 'correct horse battery staple')
    await A.click('[data-action="backup-copy"]')
    // The export is async (PBKDF2) — wait for the confirmation before reading.
    await expect(A.locator('.toast')).toContainText('Backup code copied')
    const blob = await A.evaluate(() => navigator.clipboard.readText())
    // The token self-identifies: base64 of {"m":"flock-backup",… — not the invite
    // code that was on the clipboard earlier.
    expect(blob, 'clipboard should hold the backup token').toMatch(/^eyJtIjoiZmxvY2stYmFja3Vw/)

    // A wipes the device (two-step confirm, in Advanced) — back to the welcome screen.
    await openAdvanced(A)
    await A.click('[data-action="ask-reset"]')
    await A.click('[data-action="reset-device"]')
    await expect(A.getByRole('button', { name: 'Create a circle' })).toBeVisible()

    // A wrong passphrase is rejected and nothing is restored.
    await A.click('[data-action="restore"]')
    await A.fill('#restore-code', blob)
    await A.fill('#restore-pass', 'wrong passphrase')
    await A.click('[data-action="do-restore"]')
    await expect(A.locator('.toast')).toContainText(/wrong passphrase/i)

    // The right one brings everything back.
    await A.fill('#restore-pass', 'correct horse battery staple')
    await A.click('[data-action="do-restore"]')
    await expect(A.locator('button', { hasText: 'The Smiths' })).toBeVisible({ timeout: 15_000 })

    // The proof it really works: B's next signal decrypts on the restored device.
    await sendBuzz(B, 'still here?')
    await gotoTab(A, 'circle')
    await expect(A.locator('.buzz-banner')).toBeVisible()
    await expect(A.locator('.buzz-banner')).toContainText('still here?')
  })
})
