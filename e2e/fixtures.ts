// Shared e2e helpers: spin up an isolated "person" (a fresh browser context =
// a fresh device + identity), and drive the real UI by the same data-action
// hooks the app wires. Everything two people do to each other goes through the
// live relay, so assertions on the *other* person's screen prove the transport.

import { test as base, expect, type Browser, type Page } from '@playwright/test'
import { BASE_URL } from '../playwright.config'

export { expect }
export const test = base

/** Geolocations used across specs (London + a point ~1.4 km away in Soho). */
export const LONDON = { latitude: 51.5074, longitude: -0.1278 }
export const SOHO = { latitude: 51.5137, longitude: -0.1337 }
/** Far enough to sit outside a 1 km London safe zone (Paris). */
export const PARIS = { latitude: 48.8566, longitude: 2.3522 }

export type Mode = 'family' | 'nightout'
export type Ttl = 'ongoing' | 'today' | 'custom'

/**
 * Give a device time to register its relay subscription before the other side
 * acts. flock keeps gift-wrapped signals (kind:1059) flowing through a relay; a
 * receiver must have its REQ in flight before the sender publishes, so we settle
 * briefly after any step that (re)establishes a subscription.
 */
export async function settle(page: Page, ms = 1500): Promise<void> {
  await page.waitForTimeout(ms)
}

/** Open a brand-new device: isolated storage, geolocation + clipboard granted.
 *  `opts.clock` installs Playwright's clock control before load, so a spec can
 *  fast-forward this device's time (e.g. to fire a dead-man's-switch). */
export async function newPerson(
  browser: Browser,
  geolocation = LONDON,
  opts: { clock?: boolean } = {},
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation,
    locale: 'en-GB',
  })
  const page = await context.newPage()
  if (opts.clock) await page.clock.install({ time: new Date() })
  await page.goto('/')
  // Onboarding hero is the first screen for a fresh identity.
  await expect(page.getByRole('button', { name: 'Create a circle' })).toBeVisible()
  return page
}

const sel = {
  create: '[data-action="create"]',
  doCreate: '[data-action="do-create"]',
  join: '[data-action="join"]',
  doJoin: '[data-action="do-join"]',
  joinRemote: '[data-action="join-remote"]',
  copyInvite: '[data-action="copy-invite"]',
  sendInvite: '[data-action="send-invite"]',
  sos: '[data-action="sos-hold"]',
  pickup: '[data-action="pickup"]',
  toggleShare: '[data-action="toggle-share"]',
  tab: (t: string) => `[data-action="tab"][data-tab="${t}"]`,
}

/** Create a circle from the onboarding hero. Lands on the Circle tab. */
export async function createCircle(
  page: Page,
  opts: { name: string; mode?: Mode; ttl?: Ttl } = { name: 'Circle' },
): Promise<void> {
  const { name, mode = 'family', ttl = 'ongoing' } = opts
  await page.click(sel.create)
  await page.fill('#cname', name)
  await page.click(`[data-action="ob-mode"][data-mode="${mode}"]`)
  await page.click(`[data-action="ob-ttl"][data-ttl="${ttl}"]`)
  await page.click(sel.doCreate)
  // doCreate sets tab='circle' — invite section is the proof we landed.
  await expect(page.locator(sel.copyInvite)).toBeVisible()
  await settle(page) // let the creator's inbox subscription come up
}

/** Copy the in-person invite code (carries the seed) from the Circle tab. */
export async function inviteCode(page: Page): Promise<string> {
  await gotoTab(page, 'circle')
  await expect(page.locator(sel.copyInvite)).toBeVisible()
  await page.click(sel.copyInvite)
  const code = await page.evaluate(() => navigator.clipboard.readText())
  expect(code, 'invite code should be a non-empty string').toBeTruthy()
  return code
}

/** Join an existing circle by pasting an invite code. Lands on Home. */
export async function joinByCode(page: Page, code: string): Promise<void> {
  await page.click(sel.join)
  await page.fill('#jcode', code)
  await page.click(sel.doJoin)
  // doJoin sets tab='home' — the bottom nav appears once we're in the app.
  await expect(page.locator(sel.tab('circle'))).toBeVisible()
  await settle(page) // let the joiner subscribe before the sender acts
}

/** The recipient half of a remote (gift-wrap) invite: reveal & return my npub. */
export async function joinRemoteAwait(page: Page): Promise<string> {
  await page.click(sel.join)
  await page.click(sel.joinRemote)
  await expect(page.locator('#my-npub')).toBeVisible()
  const npub = (await page.locator('#my-npub').textContent())?.trim() ?? ''
  expect(npub.startsWith('npub')).toBeTruthy()
  await settle(page) // the awaiter must be subscribed to its own inbox first
  return npub
}

/** The sender half of a remote invite: gift-wrap the seed to a recipient npub. */
export async function sendRemoteInvite(page: Page, npub: string): Promise<void> {
  await gotoTab(page, 'circle')
  await page.fill('#invite-npub', npub)
  await page.click(sel.sendInvite)
  // On a successful send, sendInvite adds the invitee to the sender's roster —
  // a durable signal. (The "Secure invite sent" toast is wiped by the immediate
  // re-render, so it can't be asserted on.)
  await expect(page.locator('.member')).toHaveCount(2)
}

export async function gotoTab(page: Page, tab: 'home' | 'map' | 'circle' | 'you'): Promise<void> {
  await page.click(sel.tab(tab))
}

/** Press-and-hold the SOS until it fires (>1.4 s), from the Home tab. */
export async function sendSOS(page: Page): Promise<void> {
  await gotoTab(page, 'home')
  const sos = page.locator(sel.sos)
  await expect(sos).toBeVisible()
  await sos.dispatchEvent('pointerdown')
  await page.waitForTimeout(1700) // hold past the 1.4 s arm threshold
  await sos.dispatchEvent('pointerup')
}

/** Start foreground location sharing (enables fixes for pick-up / coarse). */
export async function startSharing(page: Page): Promise<void> {
  await gotoTab(page, 'home')
  await page.click(sel.toggleShare)
  await settle(page) // let the first geolocation fix land before we act on it
}

/** Request a pick-up (needs a location fix first — call startSharing). */
export async function requestPickup(page: Page): Promise<void> {
  await gotoTab(page, 'home')
  await page.click(sel.pickup)
}

/** A member row on the Circle tab, addressed by the pill it currently shows. */
export function memberPill(page: Page, text: string | RegExp) {
  return page.locator('.member .pill', { hasText: text })
}

/** Buzz the circle with a custom reason (from the Circle tab).
 *  Fill + click run atomically in ONE in-page task: an inbound signal arriving
 *  between a separate fill and click re-renders the app (render-on-state rebuilds
 *  the DOM) and wipes the input — the click then sends an empty reason and the
 *  buzz silently no-ops. (The underlying UX bug — typing lost to an inbound
 *  re-render — is tracked in the audit-hardening plan.) */
export async function sendBuzz(page: Page, reason: string): Promise<void> {
  await gotoTab(page, 'circle')
  await page.waitForSelector('#buzz-custom')
  await page.evaluate((r) => {
    const input = document.getElementById('buzz-custom') as HTMLInputElement
    input.value = r
    document.querySelector<HTMLElement>('[data-action="buzz"]:not([data-reason])')?.click()
  }, reason)
}

/** Take a 1-hour break (off-grid), optionally with a reason, from Home. */
export async function takeBreak(page: Page, why?: string): Promise<void> {
  await gotoTab(page, 'home')
  await page.click('[data-action="ask-dark"]')
  await page.click('[data-action="dark-dur"][data-sec="3600"]')
  if (why) await page.fill('#dark-why', why)
  await page.click('[data-action="do-dark"]')
}

/** Expand the You tab's Advanced fold (servers, security, disband, reset). */
export async function openAdvanced(page: Page): Promise<void> {
  await gotoTab(page, 'you')
  if (!(await page.locator('#relay').isVisible())) await page.click('[data-action="toggle-advanced"]')
}

/** Disband the active circle for everyone (You tab → Advanced, two-step confirm). */
export async function disbandCircle(page: Page): Promise<void> {
  await openAdvanced(page)
  await page.click('[data-action="ask-disband"]')
  await page.click('[data-action="disband"]')
}

/** Set a private nickname for the first other member shown on the Circle tab. */
export async function setPetname(page: Page, name: string): Promise<void> {
  await gotoTab(page, 'circle')
  await page.locator('.member [data-action="edit-petname"]').first().click()
  await page.locator('.member.editing input').fill(name)
  await page.click('[data-action="save-petname"]')
}

/** Add another circle (the ＋ chip) — lands on the "Add a circle" chooser. */
export async function addCircle(page: Page): Promise<void> {
  await page.click('[data-action="add-circle"]')
  await expect(page.locator('[data-action="create"]')).toBeVisible()
}

/** Add a Safe (geofence) or Private (no-report) place via the map editor.
 *  Both are saved at the current map centre (the device's location). */
export async function addZoneOnMap(page: Page, kind: 'safe' | 'noreport' = 'safe'): Promise<void> {
  await gotoTab(page, 'map')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500) // let the style finish loading before addSource
  await page.click(`[data-action="add-zone"][data-kind="${kind}"]`)
  await page.click('[data-action="save-zone"]')
}

/** Move this device to a new emulated position (optionally with a GPS accuracy radius in metres). */
export async function setLocation(page: Page, pos: { latitude: number; longitude: number; accuracy?: number }): Promise<void> {
  await page.context().setGeolocation(pos)
  await settle(page)
}

/**
 * Move to a new position and re-arm sharing so the new spot is sampled now.
 * Emulated geolocation (CDP override) doesn't re-push to an already-running
 * `watchPosition`, so we toggle sharing off→on to take a fresh fix — the
 * equivalent of a phone actually walking out of a safe zone.
 */
export async function moveAndReshare(page: Page, pos: { latitude: number; longitude: number }): Promise<void> {
  await page.context().setGeolocation(pos)
  await gotoTab(page, 'home')
  await page.click(sel.toggleShare) // stop
  await page.click(sel.toggleShare) // start → fresh onFix at the new position
  await settle(page)
}

/** Arm the dead-man's-switch on Home with the given cadence (seconds: 900/1800/3600). */
export async function armCheckin(page: Page, intervalSeconds = 900): Promise<void> {
  await gotoTab(page, 'home')
  await page.click('[data-action="arm-menu"]')
  await page.click(`[data-action="arm"][data-interval="${intervalSeconds}"]`)
}

/** Rotate the circle key (reseed) from the You tab's Advanced fold. */
export async function reseed(page: Page): Promise<void> {
  await openAdvanced(page)
  await page.click('[data-action="reseed"]')
}

/**
 * Intercept the same-origin Overpass proxy (`/overpass/*`) on this device so the
 * fair-meeting-point venue search is deterministic and never touches the network.
 * Pass venues to return (each becomes a named Overpass `node`); pass [] to simulate
 * "no venues found", so the flow keeps the on-device centroid. Only the proposer's
 * device queries Overpass, so route it on that page.
 */
export async function mockOverpass(
  page: Page,
  venues: Array<{ name: string; lat: number; lon: number; amenity?: string }> = [],
): Promise<void> {
  const elements = venues.map((v, i) => ({
    type: 'node', id: i + 1, lat: v.lat, lon: v.lon,
    tags: { name: v.name, amenity: v.amenity ?? 'pub' },
  }))
  await page.route('**/overpass/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements }) }),
  )
}

/** This device's own public key (hex), read from local state. */
export async function myPubkey(page: Page): Promise<string> {
  const pk = await page.evaluate(() => {
    const raw = localStorage.getItem('flock:v1')
    return raw ? (JSON.parse(raw).identity?.pk ?? '') : ''
  })
  expect(pk, 'identity pubkey should be present').toMatch(/^[0-9a-f]{64}$/)
  return pk
}
