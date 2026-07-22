import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, openDmWith, myPubkey, setLocation, LONDON, SOHO } from './fixtures'

// Radar session (live navigation): the consented, time-boxed cadence lift —
// docs/plans/2026-07-21-radar-session-design.md. This proves the whole consent
// loop between two real people over the wire (ask → start → live pills both
// ends → stop ends both), the cadence lift itself (a move lands in seconds,
// far inside the 45 s floor that would otherwise suppress it), and the
// coercion surfaces: no decline control exists anywhere, and the thread keeps
// no history of any of it.
test.describe('radar session — live navigation', () => {
  test('ask → start → both pills live → lifted cadence → stop ends both', async ({ browser }) => {
    test.setTimeout(120_000)
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO)
    await createCircle(A, { name: 'Meet up' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    // Both share (an approach is mutual) at the DEFAULT precision — a coarse
    // neighbourhood cell. The session lifts precision to Exact (as well as
    // cadence), so A's radar can produce a real bearing/distance to B despite
    // neither having touched the precision slider (asserted below: the scope
    // navigates precisely, never "rough area only").
    await startSharing(A)
    await startSharing(B)

    const aPk = await myPubkey(A)
    const bPk = await myPubkey(B)

    // A asks B for live navigation from the private sheet. The chip flips to
    // "asked…" — an optimistic, quiet state; nothing enters the thread.
    await openDmWith(A, bPk)
    const askChip = A.locator('#dm-sheet [data-action="dm-live-ask"]')
    await expect(askChip).toBeVisible()
    await askChip.click()
    await expect(A.locator('#dm-sheet .chip-row button[disabled]')).toContainText(/asked/i)

    // B sees the ask as a Start pill — Accept IS Start; there is deliberately
    // NO decline control anywhere (ignoring is the only "no").
    await openDmWith(B, aPk)
    const startBtn = B.locator('#dm-sheet [data-action="dm-live-accept"]')
    await expect(startBtn).toBeVisible()
    await expect(B.locator('#dm-sheet [data-action="dm-live-decline"]')).toHaveCount(0)
    await startBtn.click()

    // Live pills on BOTH devices — a session is never invisible on either end.
    await expect(B.locator('#dm-sheet .dm-live-pill')).toContainText(/live with/i)
    await expect(A.locator('#dm-sheet .dm-live-pill')).toContainText(/live with/i, { timeout: 15_000 })

    // The lift, observed end to end: A tracks B on the radar; B's NEXT move
    // must land on A's scope in seconds. Without the session the 45 s floor
    // would suppress this second beacon (B's first went out moments ago).
    const findBtn = A.locator(`#dm-sheet [data-action="radar-member"][data-pk="${bPk}"]`)
    await expect(findBtn).toBeVisible()
    await findBtn.click()
    const shell = A.locator('#radar-shell')
    await expect(shell).toBeVisible()
    await expect(shell.locator('#radar-distance')).toHaveText(/\d/)
    // The precision lift, observed: B never raised their slider, yet the session
    // makes A's radar navigate precisely — NOT the "rough area only" a default
    // coarse share would force (the bug this closes).
    await expect(shell.locator('#radar-status')).not.toContainText(/rough area/i, { timeout: 15_000 })
    await A.waitForTimeout(7_000) // clear the 5 s session floor (jittered)
    await setLocation(B, { latitude: LONDON.latitude + 0.00027, longitude: LONDON.longitude }) // ~30 m from A
    await expect(shell.locator('#radar-range')).toHaveText('50 m', { timeout: 15_000 })
    await shell.locator('.radar-stop').click()

    // B stops the session. B's pill goes at once; A's ends on the stop signal
    // with the SAME neutral copy an expiry would show — no reasons anywhere.
    await B.locator('#dm-sheet [data-action="dm-live-stop"]').click()
    await expect(B.locator('#dm-sheet .dm-live-pill')).toHaveCount(0)
    await expect(A.locator('#dm-sheet .dm-live-pill')).toHaveCount(0, { timeout: 15_000 })

    // No history by design: the thread still reads empty — no ask, no accept,
    // no stop ever rendered as messages on either side.
    await expect(A.locator('#dm-sheet .chat-empty')).toBeVisible()
    await expect(B.locator('#dm-sheet .chat-empty')).toBeVisible()

    // And the ask chip is simply available again on both sides.
    await expect(A.locator('#dm-sheet [data-action="dm-live-ask"]')).toBeVisible()
  })
})
