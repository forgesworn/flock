import { test, expect, newPerson, createCircle, inviteCode, joinByCode, startSharing, gotoTab, openDmWith, myPubkey, setLocation, LONDON, SOHO } from './fixtures'

// Radar navigation, first slice: B selects A from the member row and gets the
// foreground motion-tracker over A's ALREADY-DISCLOSED beacon — the wire path
// (gift-wrap → relay → unwrap → presence cache → radar) proven between two real
// people. Playwright has no compass, so the spec also proves the honest
// degradation: distance guidance with a plain "no compass" line, never a
// fabricated bearing. Stop must kill the overlay at once.
test.describe('radar navigation to a person', () => {
  test("B tracks A's live share on the radar; Stop ends it", async ({ browser }) => {
    const A = await newPerson(browser, LONDON)
    const B = await newPerson(browser, SOHO) // ~700 m from A — a real bearing/distance
    await createCircle(A, { name: 'Sat night' })
    const code = await inviteCode(A)
    await joinByCode(B, code)

    await startSharing(A) // exact-spot by default; the beacon auto-emits on the first fix

    // A's beacon has landed once B's roster row carries a location claim. The
    // 🧭 sits ON the row (field feedback: behind the chevron nobody found it).
    const aPk = await myPubkey(A)
    await gotoTab(B, 'circle')
    const navBtn = B.locator(`.member-row [data-action="radar-member"][data-pk="${aPk}"]`)
    await expect(navBtn).toBeVisible()
    await navBtn.click()

    // The tracker: who, how far, how fresh — the four questions, no clutter.
    const shell = B.locator('#radar-shell')
    await expect(shell).toBeVisible()
    await expect(shell.locator('.radar-title')).toContainText(/finding/i)
    // A real distance renders (units per preference), not a placeholder dash.
    await expect(shell.locator('#radar-distance')).toHaveText(/\d/)
    await expect(shell.locator('#radar-fresh')).toHaveText(/just now|s old/)
    // The blip is on the scope: A shares exact, so it draws as a crisp dot
    // (the uncertainty band only appears for a meaningfully coarse share).
    await expect(shell.locator('#radar-blip')).toBeVisible()

    // No compass in a Playwright browser → the radar must SAY so and fall back
    // to distance guidance, not invent a bearing (the honesty rule).
    await expect(shell.locator('#radar-status')).toContainText(/no compass/i)

    // From ~700 m the scope reads at the 1 km scale…
    await expect(shell.locator('#radar-range')).toHaveText('1.0 km')

    // …and ZOOMS IN as B closes on A, so the last stretch is fine-grained
    // instead of the blip crawling around the centre of a 100 m dial.
    await setLocation(B, { latitude: LONDON.latitude + 0.00027, longitude: LONDON.longitude }) // ~30 m out
    await expect(shell.locator('#radar-range')).toHaveText('50 m')
    await expect(shell.locator('#radar-distance')).toHaveText(/^\d+ m$/)

    // At ~12 m the radar still GUIDES (no premature "you're here" dead zone)…
    await setLocation(B, { latitude: LONDON.latitude + 0.00011, longitude: LONDON.longitude })
    await expect(shell.locator('#radar-range')).toHaveText('25 m')
    await expect(shell.locator('#radar-distance')).toHaveText(/^\d+ m$/)

    // …and arrival is the true endgame: standing where A stands (1.4 m from
    // the disclosed geohash-9 cell centre) on the 10 m dial reads HERE.
    await setLocation(B, LONDON)
    await expect(shell.locator('#radar-range')).toHaveText('10 m')
    await expect(shell.locator('#radar-distance')).toHaveText('HERE')

    // Stop: one obvious control, immediate end — overlay gone, sound/haptics with it.
    await shell.locator('.radar-stop').click()
    await expect(B.locator('#radar-shell')).toHaveCount(0)

    // Second launch surface: the person's private chat (what a map-pin tap
    // opens) carries a visible "Find them" whenever they have a beacon.
    await openDmWith(B, aPk)
    const findBtn = B.locator(`#dm-sheet [data-action="radar-member"][data-pk="${aPk}"]`)
    await expect(findBtn).toBeVisible()
    await findBtn.click()
    await expect(B.locator('#radar-shell')).toBeVisible()
    await B.locator('.radar-stop').click()
    await expect(B.locator('#radar-shell')).toHaveCount(0)
  })
})
