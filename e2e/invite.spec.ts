import { test, expect, newPerson, createCircle, inviteCode, joinByCode, joinRemoteAwait, sendRemoteInvite, gotoTab, settle } from './fixtures'

test.describe('invites — both ways', () => {
  test('spoken word code (audit F4 hardening): the two-hop reference+gift-wrap flow lands B on the same circle', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Say it out loud' })

    await gotoTab(A, 'circle')
    await A.click('[data-action="share-word-code"]')
    // shareWordCode is async (parks the reference + gift-wraps the real invite
    // over the relay before the words render) — wait for them to land.
    await expect(A.locator('.wc-word').first()).toBeVisible()
    const words = await A.locator('.wc-word').allTextContents()
    expect(words, 'a spoken code should be six words').toHaveLength(6)
    await settle(A) // let both the parked reference and the gift-wrapped invite reach the relay

    await B.click('[data-action="join"]')

    // A WRONG code first (valid words, no invite parked under them) — the
    // field failure mode. The button must come back to life and the typed
    // words must survive, so a retry is a correction, not a re-type; a stuck
    // "Finding invite…" here is exactly the "words never work" report.
    const wrong = [...words.slice(1), words[0]] // rotated — still 6 valid words, different code
    await B.fill('#jwords', wrong.join(' '))
    await B.click('[data-action="join-words"]')
    await expect(B.locator('[data-action="join-words"]')).toBeEnabled({ timeout: 20_000 })
    await expect(B.locator('[data-action="join-words"]')).toHaveText('Join with words')
    await expect(B.locator('#jwords')).toHaveValue(wrong.join(' '))

    // Now the right words — the retry itself must work.
    await B.fill('#jwords', words.join(' '))
    await B.click('[data-action="join-words"]')

    // A fresh guest with no handle yet lands on the "what should this circle
    // call you?" screen first (same as the link/QR path) — skip it.
    await expect(B.locator('[data-action="join-skip"]')).toBeVisible()
    await B.click('[data-action="join-skip"]')

    await expect(B.locator('[data-action="tab"][data-tab="circle"]')).toBeVisible()
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('Say it out loud')
  })

  // The type-ahead exists so joining never depends on spelling six words exactly
  // from memory — prove it actually completes a real join, not just that chips render.
  test('spoken word code — tapping the type-ahead\'s suggestions (not typing full words) still joins', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Type-ahead trip' })

    await gotoTab(A, 'circle')
    await A.click('[data-action="share-word-code"]')
    await expect(A.locator('.wc-word').first()).toBeVisible()
    const words = await A.locator('.wc-word').allTextContents()
    await settle(A)

    await B.click('[data-action="join"]')
    for (const word of words) {
      // An unambiguous word completes itself the instant it's determined — no
      // tap needed. A genuine collision (two-plus words share this prefix)
      // leaves a chip to pick. A word no longer than 4 letters is already
      // fully typed at that point — nothing to complete or pick, so type the
      // separator ourselves, same as a real person finishing a short word.
      const prefix = word.slice(0, 4)
      await B.locator('#jwords').pressSequentially(prefix)
      await B.waitForTimeout(100) // let the synchronous auto-complete/chip render settle
      const value = await B.inputValue('#jwords')
      if (value.endsWith(`${word} `)) continue
      if (prefix === word) { await B.locator('#jwords').pressSequentially(' '); continue }
      await B.locator('.suggest-chip', { hasText: new RegExp(`^${word}$`) }).click()
    }
    await expect(B.locator('#jwords')).toHaveValue(`${words.join(' ')} `)
    await B.click('[data-action="join-words"]')

    await expect(B.locator('[data-action="join-skip"]')).toBeVisible()
    await B.click('[data-action="join-skip"]')
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('Type-ahead trip')
  })

  test('join by code (in person): the secret travels in the code, no relay needed', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    // B now holds the circle (same name in the switcher chip).
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('The Smiths')
  })

  test('join by link (the QR path): opening the link joins in one tap, then the secret is scrubbed', async ({ browser }) => {
    const A = await newPerson(browser)
    await createCircle(A, { name: 'The Smiths' })
    // The copy button now yields a LINK with the code in the #fragment — a camera
    // app OPENS it (bare-text QRs get offered to a web search, seed and all).
    const link = await inviteCode(A)
    expect(link).toContain('#join=')

    const B = await newPerson(browser)
    await B.goto(link)
    // A fresh guest with no handle yet lands on the "what should this circle
    // call you?" screen first (same as the word-code path) — skip it.
    await expect(B.locator('[data-action="join-skip"]')).toBeVisible()
    await B.click('[data-action="join-skip"]')
    // B lands joined, and the seed is scrubbed from the address bar immediately.
    await expect(B.locator('[data-action="tab"][data-tab="circle"]')).toBeVisible()
    expect(B.url()).not.toContain('join=')
    await gotoTab(B, 'circle')
    await expect(B.locator('.circle-chip.on')).toContainText('The Smiths')
  })

  test('remote invite (gift-wrap over the relay): B shares a key, A sends, B auto-joins', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'Lads trip' })

    const npub = await joinRemoteAwait(B) // B reveals npub + subscribes to its own inbox
    await sendRemoteInvite(A, npub) // A gift-wraps the seed to B's key → kind:1059

    // B receives the wrap and drops into the app on the new circle.
    await expect(B.locator('.circle-chip.on')).toContainText('Lads trip')
    await gotoTab(B, 'circle')
    // With A already a fellow member, the invite panel is tucked behind the
    // header's "＋ Invite" toggle (it only auto-opens when you're alone).
    await B.click('[data-action="toggle-invite"]')
    await expect(B.locator('[data-action="copy-invite"]')).toBeVisible()
  })
})
