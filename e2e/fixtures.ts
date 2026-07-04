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
/** Somewhere far away entirely (Paris). */
export const PARIS = { latitude: 48.8566, longitude: 2.3522 }

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
 *  fast-forward this device's time (e.g. to fire a dead-man's-switch).
 *  `opts.battery` stubs the Battery Status API before load (e.g. a dying phone). */
export async function newPerson(
  browser: Browser,
  geolocation = LONDON,
  opts: { clock?: boolean; battery?: { level: number; charging: boolean } } = {},
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation,
    locale: 'en-GB',
  })
  if (opts.battery) {
    await context.addInitScript((b) => {
      Object.defineProperty(navigator, 'getBattery', {
        configurable: true,
        value: async () => ({ level: b.level, charging: b.charging, addEventListener: () => { /* static stub */ } }),
      })
    }, opts.battery)
  }
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
  toggleShare: '[data-action="toggle-share"]',
  tab: (t: string) => `[data-action="tab"][data-tab="${t}"]`,
}

/** Create a circle from the onboarding hero. Lands on the Circle tab. */
export async function createCircle(
  page: Page,
  opts: { name: string; ttl?: Ttl } = { name: 'Circle' },
): Promise<void> {
  const { name, ttl = 'ongoing' } = opts
  await page.click(sel.create)
  await page.fill('#cname', name)
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

export async function gotoTab(page: Page, tab: 'home' | 'chat' | 'circle' | 'you'): Promise<void> {
  await page.click(sel.tab(tab))
}

/** Start foreground location sharing (beacons at the slider's precision). */
export async function startSharing(page: Page): Promise<void> {
  await gotoTab(page, 'home')
  await page.click(sel.toggleShare)
  await settle(page) // let the first geolocation fix land before we act on it
}

/** Set the Circle-tab precision slider (geohash 4–9) and commit it. Driving
 *  the input via the DOM fires the same `input`+`change` events a thumb-drag
 *  does, so the persisted value, the re-tiered watch and the forced re-emit
 *  all go through the real handler. */
export async function setSharePrecision(page: Page, precision: number): Promise<void> {
  await gotoTab(page, 'circle')
  const slider = page.locator('#share-precision')
  await expect(slider).toBeVisible()
  await slider.evaluate((el, p) => {
    const input = el as HTMLInputElement
    input.value = String(p)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, precision)
  await settle(page) // let the forced re-emit reach the relay
}

/** Tap a quick-action chip in the circle chat (Check in / Where are you? / Call me / On my way).
 *  "Check in" is its own action — it fans out to every circle as a roll-call. */
export async function quickAction(page: Page, reason: string): Promise<void> {
  await gotoTab(page, 'chat')
  if (reason === 'Check in') await page.click('[data-action="check-in"]')
  else await page.click(`[data-action="chat-preset"][data-reason="${reason}"]`)
}

/** PM "Come to me" — the confirmed quick action, private to one person, that
 *  also shares a one-shot exact spot with them alone. Assumes their DM thread
 *  is already open (openDmWith). */
export async function dmComeToMe(page: Page): Promise<void> {
  await page.click('[data-action="dm-come-to-me"]')
  await page.click('[data-action="dm-come-to-me-confirm"]')
  await settle(page) // the message + one-shot location wrap both go to the relay
}

/** Open a private 1:1 thread with a member from the Circle tab. Message is a
 *  routine action tucked behind the row's chevron. */
export async function openDmWith(page: Page, peerPk: string): Promise<void> {
  await expandMember(page, peerPk)
  await page.click(`.member [data-action="msg-member"][data-pk="${peerPk}"]`)
}

/** A member row on the Circle tab, addressed by the pill it currently shows. */
export function memberPill(page: Page, text: string | RegExp) {
  return page.locator('.member .pill', { hasText: text })
}

/** Send a message to the whole circle from the Chat tab's composer. A plain
 *  fill + click, deliberately: renders preserve the focused input (value +
 *  caret) across inbound re-renders, so every call is a live regression test
 *  of that fix. (Before it, an inbound signal between fill and click wiped
 *  the field and the send silently no-opped — the audit's input-wipe bug.) */
export async function sendBuzz(page: Page, reason: string): Promise<void> {
  await gotoTab(page, 'chat')
  await page.fill('#chat-input', reason)
  await page.click('[data-action="chat-send"]')
}

/** Expand a member's row on the Circle tab to reveal its routine actions
 *  (message/locate/petname/remove) — tucked behind a chevron so the row stays
 *  readable; a flagged-lost phone's Ring/Find/Found-it are the exception and
 *  stay always-visible instead. */
export async function expandMember(page: Page, peerPk: string): Promise<void> {
  await gotoTab(page, 'circle')
  await page.click(`.member [data-action="toggle-member-actions"][data-pk="${peerPk}"]`)
}

/** Expand the You tab's Settings fold (notifications, backup, units…). */
export async function openSettings(page: Page): Promise<void> {
  await gotoTab(page, 'you')
  if (!(await page.locator('[data-action="toggle-advanced"]').isVisible())) {
    await page.click('[data-action="toggle-settings"]')
  }
}

/** Expand Advanced (servers, security, disband, reset) — lives inside Settings. */
export async function openAdvanced(page: Page): Promise<void> {
  await openSettings(page)
  if (!(await page.locator('#relay').isVisible())) await page.click('[data-action="toggle-advanced"]')
}

/** Disband the active circle for everyone (You tab → Advanced, two-step confirm). */
export async function disbandCircle(page: Page): Promise<void> {
  await openAdvanced(page)
  await page.click('[data-action="ask-disband"]')
  await page.click('[data-action="disband"]')
}

/** Set a private nickname for the first other member shown on the Circle tab.
 *  Edit-petname is a routine action tucked behind that row's chevron. */
export async function setPetname(page: Page, name: string): Promise<void> {
  await gotoTab(page, 'circle')
  await page.locator('.member [data-action="toggle-member-actions"]').first().click()
  await page.locator('.member [data-action="edit-petname"]').first().click()
  await page.locator('.member.editing input').fill(name)
  await page.click('[data-action="save-petname"]')
}

/** Add another circle (the ＋ chip) — lands on the "Add a circle" chooser. */
export async function addCircle(page: Page): Promise<void> {
  await page.click('[data-action="add-circle"]')
  await expect(page.locator('[data-action="create"]')).toBeVisible()
}

/** Move this device to a new emulated position (optionally with a GPS accuracy radius in metres). */
export async function setLocation(page: Page, pos: { latitude: number; longitude: number; accuracy?: number }): Promise<void> {
  await page.context().setGeolocation(pos)
  await settle(page)
}

/** Rotate the circle key (reseed) from the You tab's Advanced fold. */
export async function reseed(page: Page): Promise<void> {
  await openAdvanced(page)
  await page.click('[data-action="reseed"]')
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
