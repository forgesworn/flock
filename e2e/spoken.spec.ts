import { test, expect, newPerson, createCircle, inviteCode, joinByCode, sendBuzz, gotoTab, memberPill, settle } from './fixtures'

// Spoken pick-up verification — "is this really my parent, and are they safe?".
// The check is face-to-face and on-device: one person reads the circle's rotating
// word, the other confirms it in their flock. NOTHING is published for the check
// itself (both derive it from the shared seed), so an impostor who lacks the seed
// can't produce it. Under coercion the reader gives their duress word instead: it
// verifies as an ordinary ✓ but silently raises the circle alarm for everyone else.
test.describe('spoken pick-up verification', () => {
  test('a collector proves identity face-to-face; an impostor cannot', async ({ browser }) => {
    const A = await newPerson(browser)
    const B = await newPerson(browser)
    await createCircle(A, { name: 'The Nguyens', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // A opens "Prove it's me" and reads the word straight off the tile.
    await gotoTab(A, 'circle')
    await A.click('[data-action="pickup-show"]')
    const word = (await A.locator('.word-tile').textContent())?.trim() ?? ''
    expect(word, 'a verification word should render').toBeTruthy()

    // B checks that word — no network involved; both sides derived it from the seed.
    await gotoTab(B, 'circle')
    await B.click('[data-action="pickup-check"]')
    await B.fill('#spoken-input', word)
    await B.click('[data-action="pickup-check-run"]')
    await expect(B.locator('.verify-ok')).toBeVisible()

    // A word an impostor couldn't know is rejected — don't hand over.
    await B.fill('#spoken-input', 'nightingale-not-it')
    await B.click('[data-action="pickup-check-run"]')
    await expect(B.locator('.verify-no')).toBeVisible()
  })

  test('a coerced collector’s duress word reads as ✓ yet silently alarms the circle (3 people)', async ({ browser }) => {
    const A = await newPerson(browser) // the collector, under coercion
    const B = await newPerson(browser) // the child / guardian running the check
    const C = await newPerson(browser) // another guardian — should get the silent alert
    await createCircle(A, { name: 'The Okonkwos', mode: 'family' })
    const code = await inviteCode(A)
    await joinByCode(B, code)
    await joinByCode(C, code)

    // Converge rosters so every device knows A, B and C — a check only detects duress
    // for members it knows, and a guardian only surfaces an alert about someone on its
    // roster (see spokenverify + the onIncoming help guard). Each buzzes once.
    await sendBuzz(A, 'A here'); await sendBuzz(B, 'B here'); await sendBuzz(C, 'C here')
    await settle(A, 2500); await settle(B, 2500); await settle(C, 2500)

    // A is forced to collect. On the "prove it's me" tile A reveals the duress word —
    // read here via the dev seam, the faithful stand-in for "A reads it aloud".
    const duress = await A.evaluate(
      () => (window as unknown as { flockSpoken: () => { verify: string; duress: string } | null }).flockSpoken()?.duress,
    )
    expect(duress, 'a duress word should be derivable').toBeTruthy()

    // B checks it. To B — and to a coercer watching B's screen — it reads as an
    // ordinary success, and B's own screen raises NO alarm.
    await gotoTab(B, 'circle')
    await B.click('[data-action="pickup-check"]')
    await B.fill('#spoken-input', duress as string)
    await B.click('[data-action="pickup-check-run"]')
    await expect(B.locator('.verify-ok')).toBeVisible()
    await expect(memberPill(B, 'help')).toHaveCount(0)

    // But C — the other guardian — receives the silent alarm for A over the relay.
    await gotoTab(C, 'circle')
    await expect(memberPill(C, 'help')).toBeVisible({ timeout: 15_000 })

    // And A's own phone stays calm: the coerced person is never given away.
    await gotoTab(A, 'circle')
    await expect(memberPill(A, 'help')).toHaveCount(0)
  })
})
