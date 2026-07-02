// flock PWA — UI controller. Vanilla TS, render-on-state. Wires the flock
// library (decideEmission → build signal) to real Nostr publish/subscribe.

import * as store from './store'
import type { Mode } from './store'
import * as svc from './services'
import { makeLocalSigner, makeSignetSigner, type FlockSigner } from './signer'
import { login as signetLogin, restoreSession as signetRestore, logout as signetLogout } from 'signet-login'
import { PRIVATE_RELAYS, parseRelayList } from './relays'
import { deriveCircleSeed, deriveInbox, personalInboxTag } from './keys'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from './giftwrap'
import { geocode, reverseGeocode } from './geo'
import { formatCountdown } from './countdown'
import { suggestMeetingPoint, rankVenues } from './meetingPoint'
import { searchMeetingVenues } from './venues'
import { circleToPolygon } from 'rendezvous-kit'
import type { RendezvousSuggestion, TransportMode, FairnessStrategy, Venue } from 'rendezvous-kit'
import { getProfile, fetchProfiles } from './profiles'
import { encode, decode, precisionToRadius } from 'geohash-kit'
import { shouldEmitBeacon, hasMoved, nextPollDelaySeconds, type BeaconCadence } from './cadence'
import qrcode from 'qrcode-generator'
import { npubEncode } from 'nostr-tools/nip19'
import type { MapView, MapPoint } from './map'
import { bboxContains, type BBox } from './area'
import { mapLabelMode, setMapLabelMode, type MapLabelMode } from './lang'
import { buildInviteWrap, buildReseedWraps, readInvite, buildMeetingExactWrap, readMeetingExactWrap } from './invite'
import { exportBackup, importBackup, applyBackup } from './backup'
import {
  decideEmission,
  classifyContainment,
  haversineMetres,
  signalTypeForReason,
  buildLocationSignal,
  buildHelpSignal,
  classifyPresence,
  buildCheckInSignal,
  decryptCheckIn,
  classifyCheckins,
  missedCheckins,
  CHECKIN_SIGNAL_TYPE,
  buildBuzzSignal,
  decryptBuzz,
  DEFAULT_BUZZ_REASONS,
  buildAllClearSignal,
  decryptAllClear,
  ALLCLEAR_SIGNAL_TYPE,
  buildFencesSignal,
  decryptFences,
  isNewerFenceSet,
  FENCES_SIGNAL_TYPE,
  buildDisbandSignal,
  decryptDisband,
  DISBAND_SIGNAL_TYPE,
  buildOffGridSignal,
  decryptOffGrid,
  isOffGrid,
  OFFGRID_SIGNAL_TYPE,
  type OffGrid,
  type NoReportZone,
  assessArrival,
  buildRendezvousSignal,
  decryptRendezvous,
  buildRendezvousStatusSignal,
  decryptRendezvousStatus,
  RENDEZVOUS_SIGNAL_TYPE,
  RENDEZVOUS_STATUS_TYPE,
  buildMeetingRequestSignal,
  decryptMeetingRequest,
  buildMeetingShareSignal,
  decryptMeetingShare,
  MEETING_REQUEST_TYPE,
  MEETING_SHARE_TYPE,
  type Rendezvous,
  type RendezvousStatus,
  type MeetingRequest,
  type MeetingShare,
  type TravelMode,
  deriveBeaconKey,
  decryptBeacon,
  deriveDuressKey,
  decryptDuressAlert,
  spokenCounter,
  spokenWordsFor,
  checkSpokenWord,
  type MemberBeacon,
  type CircleGeofence,
  type Geofence,
  type CheckIn,
} from '@forgesworn/flock'

// ── State ──────────────────────────────────────────────────────────────────
let persisted = store.load()
let tab: 'home' | 'map' | 'circle' | 'you' = 'home'
let fix: svc.Fix | null = null
let sharing = false
let alertActive = false // MY alert went out (confirmed publish) — sender's view only
let alertFailed = false // my SOS could not be published — persistent retry state, never a toast
let alertCircleId: string | null = null // which circle my live alert went to (stand-down target)
let breachActive = false
let geoIssue: 'denied' | 'nofix' | null = null // actionable location trouble shown as a card, not a toast
let stopWatch: (() => void) | null = null
let hidden = false // app backgrounded (page hidden) — pause sampling; a hidden PWA can't sample reliably anyway
const subs = new Map<string, () => void>() // circleId@relay@inboxPk → unsubscribe (one per circle)
// Last automatic beacon per circle — drives the movement-aware re-emit gate so a
// stationary member (identical geohash cell) doesn't keep waking the relays.
const beaconCadence = new Map<string, BeaconCadence>()
// Automatic-emit cadence (seconds). Heartbeats stay well under the 600s presence
// "stale" window, so a still member keeps reading as "active" without spamming.
const COARSE_MIN_INTERVAL = 45 // night-out: never faster than this
const COARSE_HEARTBEAT = 300 //  …but re-affirm presence every 5 min when still
const BREACH_MIN_INTERVAL = 30 // breach live-track floor
const BREACH_HEARTBEAT = 180 //   heartbeat while stationary outside a fence
// Adaptive sampling (night-out only): back off the GPS poll when stationary,
// staying under the 600 s presence "stale" window so a still member never reads
// as "gone home". Family keeps a continuous watch (see syncWatch).
const SAMPLE_POLL_BOUNDS = { minSeconds: 30, maxSeconds: 180 }
const SAMPLE_MOVE_FLOOR = 30 // metres of jitter to ignore before calling it movement
let lastSampleFix: svc.Fix | null = null
let stationaryStreak = 0
let root: HTMLElement
let toastTimer = 0

let mapView: MapView | null = null
let offlineSaving = false // "save this area" in flight
let offlineSavedBytes: number | null = null // saved offline-basemap size for the active circle
let offlineBBox: BBox | null = null // bounds of the active circle's saved map (null = not offline)
let addMode = false
let addRadius = 300

let stopInviteSub: (() => void) | null = null
let inviteSubKey = ''
let awaitingInvite = false
let pendingInviteNpub: string | null = null // a scanned invite-key link, prefilled into the send form
let showInviteLinkText = false // clipboard copy failed — render the link as selectable text instead
let showAdvanced = false // You-tab advanced settings fold (session-only)
let awaitSince = 0 // when the remote-invite wait began — drives the 'still waiting' guidance
const AWAIT_GUIDE_MS = 60_000
let armingCheckin = false
let checkinAlert = false
let monitorTimer = 0
let activeBuzz: { from: string; reason: string; mine: boolean; circle?: string } | null = null
let travelMode: TravelMode = 'walk'
// How the meeting-point search balances travel across the group. Persisted per
// device; only ever changes which candidate venue is picked (see rankVenues).
function loadMeetingFairness(): FairnessStrategy {
  try {
    const v = localStorage.getItem('flock.fairness')
    if (v === 'min_max' || v === 'min_total' || v === 'min_variance') return v
  } catch { /* localStorage may be unavailable */ }
  return 'min_max'
}
let meetingFairness: FairnessStrategy = loadMeetingFairness()
let rzvDurationMin = 60
let lastRzvStatus = 0
let rzvPick = false // picking a rendezvous spot on the map (crosshair mode)
let rzvTicker = 0 // 1 s interval driving the live countdown; 0 when idle

let onboardStep: 'intro' | 'create' | 'join' | 'await' | 'restore' = 'intro'
let onboardMode: Mode = 'family'
let adding = false // adding another circle from within the app (not first-run onboarding)
let ttlMode: 'ongoing' | 'today' | 'custom' = 'ongoing' // chosen lifetime for a new circle
let disbandConfirm = false // inline confirm for the destructive "disband for everyone"
let resetConfirm = false // inline confirm for the destructive "sign out & reset this device"
let removeConfirmPk: string | null = null // member pk pending an inline remove confirm
let covertHelpUntil = 0 // window in which my own covert help echo must NOT surface here
let goingDark = false // off-grid duration picker is open
let darkDurSec = 3600 // chosen break length (sec); -1 = custom (read from input)
let addZoneKind: 'safe' | 'noreport' = 'safe' // which kind of zone the map editor is adding
let newZonePolicy: 'withhold' | 'coarse' = 'withhold' // suppression strength for a new no-report zone
let editingPetname: string | null = null // pubkey whose nickname is being edited inline
let pickupPanel: 'show' | 'check' | null = null // spoken pick-up verify panel, if open
let pickupOutcome: 'pass' | 'fail' | null = null // last check result (duress renders as pass — no tell)
let showDuressWord = false // "prove it's me" tile is silently showing the duress word

// Per-circle live state — signals are circle-scoped, so beacons/alerts/etc. from
// one circle must never bleed into another. Keyed by circle id.
interface CircleState {
  beacons: Map<string, MemberBeacon>
  alerts: Map<string, number>
  checkins: Map<string, CheckIn>
  rzvStatuses: Map<string, RendezvousStatus>
  rendezvous: Rendezvous | null
  offgrid: Map<string, OffGrid>
  // Meeting-point search (Phase F "where"): the active proposal, each member's
  // opt-in coarse contribution, and the fair point the proposer's device computed.
  meeting: MeetingRequest | null
  meetingShares: Map<string, MeetingShare>
  meetingSuggestion: RendezvousSuggestion | null
  meetingGen: number // bumped per suggestion refresh so a stale venue fetch can't clobber a newer one
  meetingVenues: Venue[] // venues fetched for the current suggestion; the fairness toggle re-ranks these without re-fetching
}
const circleStates = new Map<string, CircleState>()
function cstate(id: string): CircleState {
  let s = circleStates.get(id)
  if (!s) { s = { beacons: new Map(), alerts: new Map(), checkins: new Map(), rzvStatuses: new Map(), rendezvous: null, offgrid: new Map(), meeting: null, meetingShares: new Map(), meetingSuggestion: null, meetingGen: 0, meetingVenues: [] }; circleStates.set(id, s) }
  return s
}
// Meeting-point requests I've declined to contribute to (by requestId). Declining
// sends nothing — this only hides the "share your spot?" prompt on my own device.
const meetingDismissed = new Set<string>()

// Presence cache — mirror member beacons to localStorage so map pins survive a
// refresh / PWA relaunch (a peer's next beacon can be up to a heartbeat — 5 min —
// away, which would otherwise leave the map blank on reload). The live Map stays the
// source of truth; this just lets a fresh load rehydrate it. Pruned by age + circle
// existence in store.load(). On-device only — no new metadata leaves the phone.
function saveBeacon(circleId: string, b: MemberBeacon): void {
  cstate(circleId).beacons.set(b.member, b)
  persisted.presence[circleId] = [...cstate(circleId).beacons.values()]
  store.save(persisted)
}
/** Forget a circle's cached pins (on reseed/leave) so stale positions never resurface. */
function dropPresence(circleId: string): void {
  if (persisted.presence[circleId]) { delete persisted.presence[circleId]; store.save(persisted) }
}
/** Restore cached pins into live state on startup so a reload doesn't blank the map. */
function rehydratePresence(): void {
  for (const [cid, list] of Object.entries(persisted.presence)) {
    const st = cstate(cid)
    for (const b of list) st.beacons.set(b.member, b)
  }
}

// ── Active circle + writers ──────────────────────────────────────────────────
function activeCircle(): store.Circle | null {
  return persisted.circles.find((c) => c.id === persisted.activeCircleId) ?? persisted.circles[0] ?? null
}
/** Live state of the active circle (the one in focus). */
function active(): CircleState | null {
  const c = activeCircle()
  return c ? cstate(c.id) : null
}
function patchActive(patch: Partial<store.Circle>): void {
  const c = activeCircle()
  if (!c) return
  persisted.circles = persisted.circles.map((x) => (x.id === c.id ? { ...x, ...patch } : x))
  store.save(persisted)
}
function patchCircleById(id: string, patch: Partial<store.Circle>): void {
  persisted.circles = persisted.circles.map((x) => (x.id === id ? { ...x, ...patch } : x))
  store.save(persisted)
}
function upsertCircle(c: store.Circle, makeActive = true): void {
  const exists = persisted.circles.some((x) => x.id === c.id)
  persisted.circles = exists ? persisted.circles.map((x) => (x.id === c.id ? c : x)) : [...persisted.circles, c]
  if (makeActive) persisted.activeCircleId = c.id
  store.save(persisted)
}
function removeCircle(id: string): void {
  persisted.circles = persisted.circles.filter((c) => c.id !== id)
  circleStates.delete(id)
  beaconCadence.delete(id)
  delete persisted.presence[id]
  if (persisted.activeCircleId === id) persisted.activeCircleId = persisted.circles[0]?.id ?? null
  store.save(persisted)
}
/** Drop transient circles whose lifetime has elapsed. Returns true if any were removed. */
function sweepExpired(): boolean {
  const now = nowSec()
  const live = persisted.circles.filter((c) => !c.expiresAt || c.expiresAt > now)
  if (live.length === persisted.circles.length) return false
  for (const c of persisted.circles) if (!live.includes(c)) { circleStates.delete(c.id); beaconCadence.delete(c.id); delete persisted.presence[c.id] }
  persisted.circles = live
  if (!live.some((c) => c.id === persisted.activeCircleId)) persisted.activeCircleId = live[0]?.id ?? null
  store.save(persisted)
  return true
}
function switchCircle(id: string): void {
  if (!persisted.circles.some((c) => c.id === id)) return
  persisted.activeCircleId = id
  store.save(persisted)
  breachActive = false
  alertActive = false
  alertFailed = false
  alertCircleId = null
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  tab = 'home'
  syncWatch() // re-tier accuracy for the newly-focused circle's mode
  render()
}

// ── Helpers ────────────────────────────────────────────────────────────────
const nowSec = (): number => Math.floor(Date.now() / 1000)
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

function shortNpub(pk: string): string {
  try { const n = npubEncode(pk); return `${n.slice(0, 10)}…${n.slice(-4)}` } catch { return pk.slice(0, 10) }
}
function fullNpub(pk: string): string {
  try { return npubEncode(pk) } catch { return pk }
}
const initials = (pk: string): string => pk.slice(0, 2).toUpperCase()

function fmtAgo(sec: number): string {
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86_400)}d ago`
}

// Sharing behaviour — plain words, not personas (internal keys stay family/nightout).
const isLive = (m: Mode): boolean => m === 'nightout'
const behaviourLabel = (m: Mode): string => (isLive(m) ? 'Share live · coarse' : 'Private until I raise it')

/** Seconds from now until the next local 04:00 — the "Today" window (covers a night that runs past midnight). */
function todayWindowSec(): number {
  const now = new Date()
  const end = new Date(now)
  end.setHours(4, 0, 0, 0)
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
  return Math.floor((end.getTime() - now.getTime()) / 1000)
}

/** True while I'm deliberately off-grid ("taking a break"). */
const isDark = (): boolean => !!persisted.offGridUntil && persisted.offGridUntil > nowSec()

/** Is this member currently off-grid in the active circle? */
function memberDark(circleId: string, pk: string): boolean {
  const o = cstate(circleId).offgrid.get(pk)
  return !!o && isOffGrid(o, nowSec())
}

/** Display name for a member: my private petname → public profile (if opted-in) →
 *  a human placeholder. An npub is never shown as a person's NAME (it reads as a
 *  glitch); the 4-char tail keeps two unnamed members tellable apart. */
function nameFor(pk: string): string {
  const pet = persisted.petnames[pk]
  if (pet) return pet
  if (persisted.showProfiles) { const p = getProfile(pk); if (p?.name) return p.name }
  try { return `Member ${npubEncode(pk).slice(-4)}` } catch { return `Member ${pk.slice(0, 4)}` }
}

/** Short label for a map pin: my private petname → public name (opted-in) → 2-char
 *  initials. Falls back to initials, never a long npub, so the pin tag stays tidy;
 *  caps a long name so one member can't stretch the tag across the map. Rendered via
 *  textContent in map.ts, so it is not (and must not be double-) HTML-escaped here. */
function pinLabel(pk: string): string {
  const name = (persisted.petnames[pk] || (persisted.showProfiles ? getProfile(pk)?.name : '') || '').trim()
  if (!name) return initials(pk)
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

/** Avatar markup — a public picture (opted-in) or initials. `isMe` shows "You". */
function avatarHtml(pk: string, isMe: boolean, small = false): string {
  const cls = small ? 'avatar small' : 'avatar'
  if (persisted.showProfiles) {
    const pic = getProfile(pk)?.picture
    if (pic) return `<span class="${cls}"><img src="${esc(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer"/></span>`
  }
  return `<span class="${cls}">${isMe ? 'You' : initials(pk)}</span>`
}

function toast(msg: string): void {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2800)
}

/** A small "what & why" helper shown while learning the app. Each hint is
 *  dismissible (✕) and the whole set has a switch in settings — the calm way to
 *  explain without cluttering a practised user's screen. */
function hint(id: string, text: string): string {
  if (!store.hintShown(persisted.hints, id)) return ''
  // Class is "tip", not "hint" — .sos already uses a .hint span for its hold label.
  return `<div class="tip">
    <span class="tip-i">i</span>
    <span class="tip-text">${esc(text)}</span>
    <button class="tip-x" data-action="dismiss-hint" data-hint="${id}" aria-label="Got it">✕</button>
  </div>`
}

// ── Icons ──────────────────────────────────────────────────────────────────
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M16.5 20a5.5 5.5 0 0 0-3-4.9"/></svg>',
  you: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><circle cx="12" cy="10" r="2.3"/><path d="M8.5 16.5a3.6 3.6 0 0 1 7 0"/></svg>',
}

// ── Mount / render ──────────────────────────────────────────────────────────
export function mount(el: HTMLElement): void {
  root = el
  // Pause sampling when the app is backgrounded, resume when it returns — a hidden PWA
  // can't sample reliably anyway, so this is pure battery saved. `hidden` starts false
  // and only flips on a real visibilitychange, so headless/normal foreground always samples.
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; syncWatch() })
  if (import.meta.env.DEV) (window as unknown as { flockSampling?: () => boolean }).flockSampling = () => !!stopWatch // e2e seam (dev only)
  // e2e seam (dev only): the active circle's current spoken words — the faithful
  // stand-in for "the collector reads the word aloud" so a test needn't fake a hold.
  if (import.meta.env.DEV) (window as unknown as { flockSpoken?: () => { verify: string; duress: string } | null }).flockSpoken = () => {
    const ctx = spokenCtx()
    return ctx ? spokenWordsFor(ctx.seedHex, ctx.me, ctx.counter, ctx.members) : null
  }
  rehydratePresence() // restore cached member pins so a refresh doesn't blank the map
  store.save(persisted) // persist any legacy→multi-circle migration / pruning straight away
  // A join link (scanned QR / tapped in a chat) arrives as a #join= fragment —
  // never sent to any server. Scrub it from the address bar BEFORE anything else
  // runs: it carries the seed.
  const frag = consumeFragment()
  render()
  if (frag?.kind === 'join') joinFromLink(frag.value)
  if (frag?.kind === 'invite') inviteFromLink(frag.value)
  // Tapping a link while flock is already open is a fragment-only navigation —
  // no reload, no fresh mount — so consume those too.
  window.addEventListener('hashchange', () => {
    const f = consumeFragment()
    if (f?.kind === 'join') joinFromLink(f.value)
    if (f?.kind === 'invite') inviteFromLink(f.value)
  })
  void restoreSignet()
}

/** Pull a #join= (circle invite — carries the SEED) or #invite= (someone's public
 *  key, to prefill the send-invite form) out of the fragment, scrubbing the address
 *  bar/history straight away. */
function consumeFragment(): { kind: 'join' | 'invite'; value: string } | null {
  const m = location.hash.match(/^#(join|invite)=(.+)$/)
  if (!m) return null
  history.replaceState(null, '', location.pathname + location.search)
  return { kind: m[1] as 'join' | 'invite', value: decodeURIComponent(m[2]) }
}

/** A scanned "invite key" QR: jump to the send-invite form with the key filled in. */
function inviteFromLink(npub: string): void {
  if (!persisted.identity || !activeCircle()) { toast('Create or join a circle first, then scan their key again'); return }
  try { store.npubToHex(npub) } catch { toast("That key doesn't look right — ask them to show the QR again"); return }
  pendingInviteNpub = npub
  tab = 'circle'
  render()
  toast('Key filled in — tap Send encrypted invite')
}

/** Join straight from a scanned/tapped link — the same path as a pasted code. */
function joinFromLink(code: string): void {
  try {
    const circle = store.decodeInvite(store.inviteCodeFrom(code))
    if (persisted.circles.some((c) => c.id === circle.id)) { switchCircle(circle.id); return }
    persisted.identity ??= store.createIdentity()
    circle.members = [persisted.identity.pk]
    circle.joinedAt = nowSec() // the roster about to replay is not news — see JOIN_GRACE_SEC
    upsertCircle(circle, true)
    onboardStep = 'intro'
    adding = false
    tab = 'home'
    render()
    toast(`You've joined ${circle.name}`)
  } catch { toast('That join link is not valid — ask for a fresh one.') }
}

function render(): void {
  if (tab !== 'map' && mapView) { mapView.destroy(); mapView = null; addMode = false; rzvPick = false }
  syncRzvTicker() // start/stop the live countdown to match the current screen
  if (persisted.identity) ensureInviteSub()
  if (!persisted.identity || !activeCircle() || adding) {
    root.innerHTML = onboardingView()
    wireOnboard()
    return
  }
  ensureMember(activeCircle() as store.Circle, persisted.identity.pk)
  ensureSubscriptions()
  ensureProfiles()
  startMonitor()
  const body = tab === 'home' ? homeView() : tab === 'map' ? mapView_screen() : tab === 'circle' ? circleView() : youView()
  root.innerHTML = `${buzzBanner()}<main class="screen fade-in ${tab === 'map' ? 'map-screen' : ''}">${body}</main>${navView()}<div class="toast" id="toast"></div>`
  wireApp()
}

// ── Views: app ───────────────────────────────────────────────────────────────
function topbar(showModeToggle: boolean): string {
  const c = activeCircle() as store.Circle
  const toggle = showModeToggle ? `
    <div class="mode-toggle" role="group" aria-label="Sharing">
      <button data-action="mode" data-mode="family" aria-pressed="${c.mode === 'family'}">Private</button>
      <button data-action="mode" data-mode="nightout" aria-pressed="${c.mode === 'nightout'}">Share live</button>
    </div>` : ''
  return `<div class="topbar">
    <div class="brand"><img class="logo" src="./icon.svg" alt=""/><span class="name wordmark">flock</span></div>
    ${toggle}
  </div>
  ${circleSwitcher()}`
}

/** Compact remaining-lifetime label for a transient circle ('' for long-lived). */
function fmtTtl(expiresAt?: number): string {
  if (!expiresAt) return ''
  const left = expiresAt - nowSec()
  if (left <= 0) return 'ending'
  if (left < 3600) return `${Math.round(left / 60)}m`
  if (left < 86_400) return `${Math.round(left / 3600)}h`
  return `${Math.round(left / 86_400)}d`
}

/** Horizontal chip row to switch between circles + add a new one. */
function circleSwitcher(): string {
  if (persisted.circles.length < 1) return ''
  const active = activeCircle()?.id
  const chips = persisted.circles.map((c) => {
    const ttl = fmtTtl(c.expiresAt)
    return `<button class="circle-chip${c.id === active ? ' on' : ''}" data-action="switch-circle" data-id="${c.id}">${esc(c.name)}${ttl ? `<span class="ttl">${ttl}</span>` : ''}</button>`
  }).join('')
  return `<div class="circle-switch">${chips}<button class="circle-chip add" data-action="add-circle" aria-label="Add a circle">＋</button></div>`
}

function orbState(): { cls: string; label: string; sub: string; action?: string } {
  const c = activeCircle() as store.Circle
  if (alertFailed) return { cls: 'state-alert', label: "Help didn't send", sub: 'Tap to try again — check your signal', action: 'sos-retry' }
  if (alertActive) return { cls: 'state-alert', label: 'Help sent', sub: 'Your circle has been alerted' }
  const inc = incomingAlert()
  if (inc) return { cls: 'state-alert', label: `${inc.name} needs help`, sub: 'Tap to see where', action: 'see-alert' }
  if (checkinAlert) return { cls: 'state-alert', label: 'Check-in missed', sub: "Someone hasn't checked in" }
  if (isDark()) return { cls: 'state-dark', label: 'Taking a break', sub: `Sharing nothing · back in ${fmtMins((persisted.offGridUntil ?? 0) - nowSec())}` }
  if (breachActive) return { cls: 'state-alert', label: 'Outside safe place', sub: 'Location shared with your circle' }
  if (sharing && fix) {
    return isLive(c.mode)
      ? { cls: 'state-share', label: 'Sharing live', sub: 'Rough location · your circle can see you' }
      : { cls: 'state-safe', label: 'On watch', sub: 'Stays hidden unless you raise it' }
  }
  if (sharing && !fix) return { cls: 'state-share', label: 'Locating…', sub: 'Getting a GPS fix' }
  return { cls: 'state-safe', label: 'Private', sub: 'Location hidden until you need it' }
}

/** The newest live help alert raised by someone ELSE, across ALL circles — an
 *  alert must surface even while the person is focused on another circle. */
function incomingAlert(): { who: string; name: string; circleId: string; ts: number } | null {
  const me = persisted.identity?.pk
  let best: { who: string; name: string; circleId: string; ts: number } | null = null
  for (const c of persisted.circles) {
    for (const [who, ts] of cstate(c.id).alerts) {
      if (who === me) continue
      if (!best || ts > best.ts) best = { who, name: nameFor(who), circleId: c.id, ts }
    }
  }
  return best
}

function homeView(): string {
  const c = activeCircle() as store.Circle
  const s = orbState()
  return `
    ${topbar(true)}
    <div class="orb-wrap ${s.cls}"${s.action ? ` data-action="${s.action}" role="button" tabindex="0"` : ''}>
      <div class="orb"><div class="orb-inner">
        <div class="orb-state"><span class="orb-dot"></span>${esc(s.label)}</div>
        <div class="orb-sub">${esc(s.sub)}</div>
      </div></div>
    </div>
    <div class="actions">
      ${alertActive ? '<button class="btn primary" data-action="im-safe">I\'m safe now</button>' : ''}
      <button class="btn ${sharing ? 'ghost' : 'primary'}" data-action="toggle-share">
        ${sharing ? 'Stop sharing' : (isLive(c.mode) ? 'Start sharing' : 'Start safety watch')}
      </button>
      ${hint('home-watch', isLive(c.mode)
        ? 'Sharing live lets your circle see roughly where you are — a neighbourhood, never your exact address.'
        : 'Keeps an eye on your safe places and stands ready for a pick-up or SOS. Your exact spot stays hidden until you need it.')}
      <button class="btn warn" data-action="pickup">Pick me up</button>
      <div class="sos" data-action="sos-hold" data-armed="false" role="button" tabindex="0" aria-label="Hold to send help">
        <div class="fill"></div>
        <span class="label">Hold for help</span>
        <span class="hint">Press and hold to send an SOS</span>
      </div>
      ${hint('home-sos', 'Pick me up asks your circle to come and get you. Hold for help is an emergency SOS — it alerts everyone and shares where you are.')}
    </div>
    ${geoIssueCard()}
    ${inviteCta()}
    <div style="margin-top:14px">${breakCard()}</div>
    <div style="margin-top:14px">${checkinCard()}</div>`
}

/** Location trouble as an actionable, persistent card — a denied permission is a
 *  settings change only the user can make; a raw error toast is a dead end. */
function geoIssueCard(): string {
  if (geoIssue === 'denied') {
    return `<div class="card stack geo-issue" style="margin-top:14px">
      <strong>flock can't see your location</strong>
      <div class="note">Location is blocked for this browser, so sharing switched itself off. Allow it in your phone's settings (Settings → your browser → Location → “While using”), then try again.</div>
      <button class="btn small" data-action="geo-retry">Try again</button>
    </div>`
  }
  if (geoIssue === 'nofix') {
    return `<div class="card geo-issue" style="margin-top:14px">
      <strong>Looking for you…</strong>
      <div class="note">No GPS fix yet — still trying. Being near a window or outside helps.</div>
    </div>`
  }
  return ''
}

/** A loud, friendly nudge to invite people while you're the only one here. */
function inviteCta(): string {
  if (members().length > 1) return ''
  return `<div class="card invite-cta" data-action="go-invite" role="button" tabindex="0">
    <div class="cta-emoji">👋</div>
    <div class="cta-text"><strong>It's just you so far</strong><span>Add the people you want to stay close to.</span></div>
    <span class="cta-go">Invite →</span>
  </div>`
}

/** "Take a break" — go off-grid for a while without worrying anyone. */
function breakCard(): string {
  if (isDark()) {
    const back = fmtMins((persisted.offGridUntil ?? 0) - nowSec())
    return `<div class="card stack break-on">
      <div class="row" style="justify-content:space-between">
        <div><strong>On a break</strong><div class="note">Sharing nothing · back in ${back}. Your circle knows it's planned.</div></div>
      </div>
      <button class="btn primary" data-action="come-back">I'm back now</button>
    </div>`
  }
  if (goingDark) {
    const dur = (sec: number, label: string): string =>
      `<button class="btn small${darkDurSec === sec ? ' primary' : ''}" data-action="dark-dur" data-sec="${sec}">${label}</button>`
    return `<div class="card stack">
      <div class="row" style="justify-content:space-between"><strong>Take a break</strong><button class="btn small ghost" data-action="cancel-dark">Cancel</button></div>
      <div class="note">Stop sharing for a while. Your circle is told it's planned, so no one worries and no alarm goes off.</div>
      <div class="chip-row">${dur(3600, '1 hour')}${dur(todayWindowSec(), 'Today')}${dur(-1, 'Custom')}</div>
      <div id="dark-custom" class="row" style="gap:8px"${darkDurSec === -1 ? '' : ' hidden'}>
        <input class="input" id="dark-num" type="number" min="1" max="48" value="2" style="max-width:90px" />
        <span class="muted" style="align-self:center">hours</span>
      </div>
      <input class="input" id="dark-why" placeholder="Why? (optional) — e.g. at the cinema" autocapitalize="sentences" />
      <button class="btn primary" data-action="do-dark">Start break</button>
    </div>`
  }
  return `<button class="btn ghost" data-action="ask-dark">Take a break · pause sharing</button>`
}

function fmtMins(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`
  return `${Math.round(sec / 60)}m`
}

function checkinCard(): string {
  const c = activeCircle() as store.Circle
  const interval = c.checkinInterval ?? 0
  if (armingCheckin) {
    return `<div class="card stack">
      <div class="row" style="justify-content:space-between"><strong>How often to check in</strong><button class="btn small ghost" data-action="cancel-arm">Cancel</button></div>
      <div class="note">You'll be expected to tap “I'm OK” within this window. Miss it and your circle is alerted.</div>
      <div class="chip-row">
        <button class="btn small" data-action="arm" data-interval="900">15 min</button>
        <button class="btn small" data-action="arm" data-interval="1800">30 min</button>
        <button class="btn small" data-action="arm" data-interval="3600">1 hour</button>
      </div>
    </div>`
  }
  if (interval > 0) {
    const me = persisted.identity?.pk
    const mine = me ? cstate(c.id).checkins.get(me) : undefined
    const dueIn = mine ? (mine.timestamp + interval) - nowSec() : 0
    const overdue = dueIn <= 0
    return `<div class="card stack checkin-armed${overdue ? ' overdue' : ''}">
      <div class="row" style="justify-content:space-between">
        <div><strong>Automatic check-in</strong><div class="note">${overdue ? 'Overdue — check in now' : `Next check-in in ${fmtMins(dueIn)}`}</div></div>
        <button class="btn small ghost" data-action="disarm-checkin">Turn off</button>
      </div>
      <button class="btn primary" data-action="checkin">I'm OK — check in</button>
    </div>`
  }
  return `<button class="btn ghost" data-action="arm-menu">Set up check-ins · an automatic alert if one is missed</button>`
}

function circleMemberRow(pk: string, mePk: string): string {
  const cid = activeCircle()?.id ?? ''
  const st = active()
  const isMe = pk === mePk

  if (!isMe && editingPetname === pk) {
    return `<div class="member editing">
      ${avatarHtml(pk, isMe)}
      <input class="input" id="pet-${pk}" placeholder="Nickname (just for you)" value="${esc(persisted.petnames[pk] ?? '')}" autocapitalize="words" style="flex:1" />
      <button class="btn small primary" data-action="save-petname" data-pk="${pk}">Save</button>
      <button class="btn small ghost" data-action="cancel-petname" aria-label="Cancel">✕</button>
    </div>`
  }

  const beacon = st?.beacons.get(pk)
  const presence = beacon ? classifyPresence([beacon], nowSec(), { staleAfterSeconds: 600 })[0] : null
  const ci = st?.checkins.get(pk)
  const ciState = ci ? classifyCheckins([ci], nowSec())[0] : null
  const dark = !isMe && !!cid && memberDark(cid, pk)

  let pill: string
  if (st?.alerts.has(pk)) pill = '<span class="pill alert">help</span>'
  else if (dark) pill = '<span class="pill dark">on a break</span>'
  else if (ciState?.status === 'missed') pill = '<span class="pill alert">missed</span>'
  else if (ciState?.status === 'overdue') pill = '<span class="pill warn">overdue</span>'
  else if (ciState) pill = '<span class="pill active">checked in</span>'
  else if (presence) pill = presence.status === 'active'
    ? `<span class="pill active">out · ${fmtAgo(presence.ageSeconds)}</span>`
    : `<span class="pill stale">home · ${fmtAgo(presence.ageSeconds)}</span>`
  else pill = '<span class="pill">no activity</span>'

  const sub = beacon ? (isMe ? 'you · on the map' : 'location on the map') : isMe ? 'you' : 'in this circle'
  const edit = isMe ? '' : `<button class="icon-btn" data-action="edit-petname" data-pk="${pk}" aria-label="Set a nickname">✎</button>`
  const isNew = (activeCircle()?.unseenMembers ?? []).includes(pk)
  return `<div class="member${isNew ? ' unseen' : ''}">
    ${avatarHtml(pk, isMe)}
    <div class="meta"><div class="who">${isMe ? 'You' : esc(nameFor(pk))}${isNew ? ' <span class="pill new">new</span>' : ''}</div><div class="when">${sub}</div></div>
    ${pill}${edit}
  </div>`
}

/** The two ways to add someone: in-person QR/code, and remote encrypted invite. */
function inviteSections(): string {
  return `
    <div class="section-title" style="margin-top:22px">Show a code (in person)</div>
    <div class="card stack">
      <div class="qr" id="qr"></div>
      ${showInviteLinkText && activeCircle() ? `<div class="invite-code">${esc(store.inviteLink(activeCircle() as store.Circle, location.origin))}</div>` : ''}
      <button class="btn primary" data-action="copy-invite">Copy invite link</button>
      <div class="note">Let them scan the QR with their camera — it opens flock and joins in one tap. Or copy the link and send it. It carries the secret, so treat it like a password.</div>
    </div>

    <div class="section-title" style="margin-top:22px">Send to their key (remote)</div>
    <div class="card stack">
      ${hint('invite-remote', "In person? Show them the QR above. Far away? Ask them to open flock, tap 'Join remotely', and send you the key it shows.")}
      <div class="field"><label for="invite-npub">Their invite key</label><input class="input" id="invite-npub" placeholder="npub1…" value="${esc(pendingInviteNpub ?? '')}" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <button class="btn small primary" data-action="send-invite">Send encrypted invite</button>
      <div class="note">Encrypted just for them — safe to send through any chat. Ask them to tap “Join remotely” and send you the key it shows.</div>
    </div>`
}

function circleView(): string {
  const c = activeCircle() as store.Circle
  const me = persisted.identity as store.Identity
  const mem = members()
  const alone = mem.length <= 1
  const rows = mem.length
    ? mem.map((pk) => circleMemberRow(pk, me.pk)).join('')
    : '<div class="card muted">Just you so far.</div>'
  const lead = alone
    ? `<div class="card invite-lead"><div class="cta-emoji">👋</div><div class="cta-text"><strong>Add your people</strong><span>Share a code in person, or send an invite to someone's key.</span></div></div>${inviteSections()}`
    : ''
  const unseen = c.unseenMembers ?? []
  const joinNotice = unseen.length
    ? `<div class="card new-member-notice" role="alert">
        <div><strong>〰️ ${unseen.length === 1 ? 'A new phone' : `${unseen.length} new phones`} joined ${esc(c.name)}</strong>
        <div class="note">Anyone holding the invite code can join. Tap ✎ on their row to give them a name you'll recognise. Not expecting anyone? Remove them under You → Circle security — that locks them out.</div></div>
        <button class="btn small ghost" data-action="ack-new-members">Got it</button>
      </div>`
    : ''
  return `
    ${topbar(false)}
    <h2 style="margin-bottom:14px">${esc(c.name)}</h2>
    ${joinNotice}
    ${lead}
    <div class="section-title"${alone ? ' style="margin-top:22px"' : ''}>Members</div>
    <div class="list">${rows}</div>

    <div class="section-title" style="margin-top:22px">Buzz the circle</div>
    <div class="card stack">
      <div class="chip-row">
        ${DEFAULT_BUZZ_REASONS.map((r) => `<button class="btn small" data-action="buzz" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}
      </div>
      <div class="row" style="gap:8px">
        <input class="input" id="buzz-custom" placeholder="Custom reason…" autocapitalize="sentences" />
        <button class="btn small primary" data-action="buzz">Buzz</button>
      </div>
      <div class="note">A gentle alert to everyone — their phone buzzes with your reason.</div>
    </div>

    ${pickupCard()}

    ${meetingCard()}

    ${rzvCard()}

    ${alone ? '' : inviteSections()}`
}

// Spoken pick-up verification — "is this really my parent, and are they safe?".
// A face-to-face, on-device check: one person reads the circle's rotating word
// aloud, the other confirms it in their flock. Nothing is published (see
// spokenverify.ts) — an impostor can't know the word. Under coercion the reader
// gives their duress word instead: it looks ordinary, verifies as a normal ✓, and
// silently raises the circle alarm for everyone else.
function pickupCard(): string {
  return `<div class="section-title" style="margin-top:22px">Pick-up check</div>
    <div class="card stack">
      ${pickupPanel === 'show' ? pickupShowInner()
        : pickupPanel === 'check' ? pickupCheckInner()
        : `${hint('pickup-check', "Confirm a person face-to-face with a secret word only your circle knows — for school pick-ups or meeting up in a crowd.")}
           <div class="note">Confirm who's collecting — face to face, no signal needed. An impostor can't fake the word.</div>
           <div class="row" style="gap:10px">
             <button class="btn small primary" data-action="pickup-show">Prove it's me</button>
             <button class="btn small" data-action="pickup-check">Check someone</button>
           </div>`}
    </div>`
}

// "Prove it's me": show my word to read aloud. Long-pressing the tile silently
// swaps in my duress word (no label, identical styling) — the coercion channel.
function pickupShowInner(): string {
  const ctx = spokenCtx()
  if (!ctx) return '<div class="note">Add someone to your circle first.</div>'
  const words = spokenWordsFor(ctx.seedHex, ctx.me, ctx.counter, ctx.members)
  const word = showDuressWord ? words.duress : words.verify
  return `<div class="note">Read this word to whoever's checking. They confirm it in their flock.</div>
    <div class="word-tile" data-action="spoken-reveal">${esc(word)}</div>
    <div class="note subtle">Rotates automatically. Only your circle can produce it.</div>
    <button class="btn small ghost" data-action="pickup-close">Done</button>`
}

// "Check someone": type the word they said. verified / stale / duress all render an
// identical ✓ (the duress case MUST look ordinary); only a real mismatch shows ✗.
function pickupCheckInner(): string {
  const outcome = pickupOutcome === 'pass'
    ? '<div class="verify-ok">✓ Verified — it’s really them</div>'
    : pickupOutcome === 'fail'
      ? '<div class="verify-no">✗ That’s not the word — don’t hand over</div>'
      : ''
  return `<div class="note">Ask who's collecting for their word, then type it here.</div>
    <div class="field"><input class="input" id="spoken-input" placeholder="The word they said" autocapitalize="none" autocorrect="off" autocomplete="off" spellcheck="false" /></div>
    <button class="btn small primary" data-action="pickup-check-run">Check</button>
    ${outcome}
    <button class="btn small ghost" data-action="pickup-close">Done</button>`
}

function youView(): string {
  const me = persisted.identity as store.Identity
  const c = activeCircle() as store.Circle
  return `
    ${topbar(false)}
    <h2 style="margin-bottom:14px">You &amp; settings</h2>
    <div class="section-title">Identity</div>
    <div class="card stack">
      <div class="kv"><span class="k">Your invite key</span><span>${shortNpub(me.pk)}</span></div>
      <div class="kv"><span class="k">Sign-in</span><span>${persisted.authMethod === 'signet' ? 'Signed in with Signet' : 'Quick start (this device only)'}</span></div>
      <button class="btn small ghost" data-action="copy-npub">Copy my invite key</button>
      <div class="note">${persisted.authMethod === 'signet'
        ? 'Signed in with Signet — your key lives in your signer and never touches flock.'
        : 'Quick-start key, stored in this browser only — not secure key storage. Sign in with Signet for real use.'}</div>
    </div>
    <div class="section-title" style="margin-top:18px">Tips &amp; help</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <span>Show helper tips</span>
        <button class="switch${(persisted.hints?.on ?? true) ? ' on' : ''}" data-action="toggle-hints" role="switch" aria-checked="${persisted.hints?.on ?? true}"><span class="knob"></span></button>
      </div>
      <div class="note">Small explanations appear around the app while you're learning. Turn them off once you're comfortable.</div>
      ${persisted.hints?.dismissed.length ? '<button class="btn small ghost" data-action="reset-hints">Bring all tips back</button>' : ''}
    </div>
    <div class="section-title" style="margin-top:18px">Names &amp; photos</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <span>Show public profiles</span>
        <button class="switch${persisted.showProfiles ? ' on' : ''}" data-action="toggle-profiles" role="switch" aria-checked="${!!persisted.showProfiles}"><span class="knob"></span></button>
      </div>
      <div class="note">Off by default. When on, flock fetches public names &amp; photos from public relays — which tells them who you're looking up. Your private nicknames always work and never leave this device.</div>
    </div>
    <div class="section-title" style="margin-top:18px">Backup</div>
    <div class="card stack">
      <div class="note">One encrypted code holds your key, circles, nicknames and private places. Restore it from the welcome screen on any device. The passphrase is the only way in — nobody can reset it.</div>
      <div class="field"><label for="backup-pass">Passphrase</label><input class="input" id="backup-pass" type="password" autocomplete="new-password" placeholder="Pick a strong passphrase" /></div>
      <div class="row" style="gap:10px">
        <button class="btn small" data-action="backup-copy">Copy backup code</button>
        <button class="btn small ghost" data-action="backup-download">Download file</button>
      </div>
    </div>
    <button class="btn ghost" data-action="toggle-advanced" style="margin-top:18px" aria-expanded="${showAdvanced}">${showAdvanced ? 'Hide advanced settings' : 'Advanced settings…'}</button>
    ${showAdvanced ? advancedSections(me, c) : ''}
    <div class="note" style="margin-top:16px;text-align:center">flock · your location, shared only when you choose</div>`
}

/** The sharp tools, folded away by default: servers, security, disband, reset.
 *  A practised user opens this once; a new user never trips over it. */
function advancedSections(me: store.Identity, c: store.Circle): string {
  return `
    <div class="section-title" style="margin-top:18px">Delivery servers</div>
    <div class="card stack">
      ${hint('relays', "flock sends your encrypted alerts through these servers. More than one means an alert can't be lost if one is down.")}
      <div class="field"><label for="relay">Server addresses (one per line)</label><textarea class="input" id="relay" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(persisted.relayUrls.join('\n'))}</textarea></div>
      <div class="note">Alerts go to every server here, so one being down can't swallow an SOS. Add a backup you trust — even encrypted, a public server still sees the timing of your traffic.</div>
      <button class="btn small" data-action="save-relay">Save servers</button>
    </div>
    <div class="section-title" style="margin-top:18px">Circle security</div>
    <div class="card stack">
      <button class="btn small" data-action="reseed">Reset this circle's security</button>
      <div class="note">Creates a fresh secret and hands it privately to the members you keep. Do this if an invite may have leaked.</div>
      ${members().filter((pk) => pk !== me.pk).map((pk) => removeConfirmPk === pk
        ? `<div class="row">${avatarHtml(pk, false, true)}<span class="who" style="font-size:14px">${esc(nameFor(pk))}</span></div>
           <div class="note" style="color:var(--alert)">Removes ${esc(nameFor(pk))} and resets the circle's security — they're cut off straight away.</div>
           <div class="row" style="gap:10px">
             <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="remove-member" data-pk="${pk}">Remove</button>
             <button class="btn small ghost" data-action="cancel-remove">Cancel</button>
           </div>`
        : `<div class="row">${avatarHtml(pk, false, true)}<span class="who" style="font-size:14px">${esc(nameFor(pk))}</span><button class="btn small ghost" style="margin-left:auto" data-action="ask-remove" data-pk="${pk}">Remove</button></div>`).join('') || '<div class="note">No other members yet.</div>'}
    </div>
    <div class="section-title" style="margin-top:18px">This circle</div>
    <div class="card stack">
      <div class="kv"><span class="k">Name</span><span>${esc(c.name)}</span></div>
      <div class="kv"><span class="k">Sharing</span><span>${behaviourLabel(c.mode)}</span></div>
      <div class="kv"><span class="k">Lifetime</span><span>${c.expiresAt ? `temporary · ends in ${fmtTtl(c.expiresAt)}` : 'ongoing'}</span></div>
      <button class="btn ghost" data-action="leave">Leave this circle</button>
      <div class="note">Leaving removes it from this device only. Your other circles and your key stay put.</div>
      ${disbandConfirm
        ? `<div class="note" style="color:var(--alert)">This ends “${esc(c.name)}” for <strong>everyone</strong> and wipes its key — it can't be undone.</div>
           <div class="row" style="gap:10px">
             <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="disband">Disband for everyone</button>
             <button class="btn small ghost" data-action="cancel-disband">Cancel</button>
           </div>`
        : '<button class="btn small ghost" style="color:var(--alert)" data-action="ask-disband">Disband for everyone…</button>'}
    </div>
    <div class="card stack" style="margin-top:14px">
      ${resetConfirm
        ? `<div class="note" style="color:var(--alert)">This wipes your key and every circle from this device. Without a backup (the card above) there is <strong>no way back</strong>.</div>
           <div class="row" style="gap:10px">
             <button class="btn small ghost" style="color:var(--alert);border-color:var(--alert-dim)" data-action="reset-device">Wipe this device</button>
             <button class="btn small ghost" data-action="cancel-reset">Cancel</button>
           </div>`
        : `<button class="btn small ghost" data-action="ask-reset">Sign out &amp; reset this device…</button>
           <div class="note">Wipes your key and every circle from this browser.</div>`}
    </div>
  `
}

function navView(): string {
  const item = (id: string, label: string, icon: string): string =>
    `<button data-action="tab" data-tab="${id}" aria-current="${tab === id}">${icon}<span>${label}</span></button>`
  return `<nav class="nav">${item('home', 'Home', ICON.home)}${item('map', 'Map', ICON.map)}${item('circle', 'Circle', ICON.circle)}${item('you', 'You', ICON.you)}</nav>`
}

// ── Map screen ───────────────────────────────────────────────────────────────
function mapView_screen(): string {
  return `
    ${topbar(false)}
    <div class="map-shell">
      <div class="map-stage">
        <div id="map" class="map-canvas"></div>
        <div id="crosshair" class="crosshair"${addMode || rzvPick ? '' : ' hidden'}></div>
        <div id="offline-oob" class="offline-oob" hidden></div>
      </div>
      <div class="map-panel" id="map-panel">${mapPanelInner()}</div>
    </div>`
}

function radiusOf(z: Geofence): string {
  return z.kind === 'circle' ? `${Math.round(z.radiusMetres)} m across` : `${z.vertices.length}-point area`
}

function mapPanelInner(): string {
  if (rzvPick) {
    return `
      <div class="row" style="justify-content:space-between"><strong>Meeting point</strong></div>
      <div class="note">Pan the map so the crosshair sits where you'll meet, then set it.</div>
      <div class="row" style="gap:10px">
        <button class="btn small primary" data-action="rzv-pick-set">Set meeting point here</button>
        <button class="btn small ghost" data-action="rzv-pick-cancel">Cancel</button>
      </div>`
  }
  if (addMode) {
    const noreport = addZoneKind === 'noreport'
    const kindToggle = `
      <div class="mode-toggle" role="group" aria-label="Place type" style="margin-bottom:10px">
        <button data-action="zone-kind" data-kind="safe" aria-pressed="${!noreport}">Safe place</button>
        <button data-action="zone-kind" data-kind="noreport" aria-pressed="${noreport}">Private place</button>
      </div>`
    const policyToggle = noreport ? `
      <div class="note" style="margin-top:2px">How private?</div>
      <div class="chip-row">
        <button class="btn small${newZonePolicy === 'withhold' ? ' primary' : ''}" data-action="zone-policy" data-policy="withhold">Hide completely</button>
        <button class="btn small${newZonePolicy === 'coarse' ? ' primary' : ''}" data-action="zone-policy" data-policy="coarse">Rough area only</button>
      </div>` : ''
    const help = noreport
      ? 'A spot that stays hidden — like home. Even if you ask for help, the exact place isn’t shared.'
      : 'Somewhere you’re meant to be. Your circle is told if you leave it.'
    return `
      <div class="row" style="justify-content:space-between">
        <strong>${noreport ? 'New private place' : 'New safe place'}</strong>
        <span class="muted" id="radius-label">${addRadius} m</span>
      </div>
      ${kindToggle}
      ${policyToggle}
      <input class="slider" id="radius" type="range" min="100" max="2000" step="50" value="${addRadius}" />
      <div class="note">${help} Pan so the crosshair sits at the centre, then save.</div>
      <div class="row" style="gap:10px">
        <button class="btn small primary" data-action="save-zone">Save</button>
        <button class="btn small ghost" data-action="cancel-zone">Cancel</button>
      </div>`
  }
  const safe = activeFences()
  const safeList = safe.length
    ? safe.map((z, i) => `<div class="zone-row"><span class="dot-safe"></span><span class="zone-meta">Safe place ${i + 1}<small>${radiusOf(z)}</small></span><button class="zone-del" data-action="del-zone" data-i="${i}" aria-label="Delete">✕</button></div>`).join('')
    : '<div class="note">None yet. Add a safe place and you’ll be told if a circle member leaves it.</div>'
  const priv = persisted.noReportZones
  const privList = priv.length
    ? priv.map((z, i) => {
        const how = (z.policy ?? 'withhold') === 'coarse' ? 'rough area only' : 'hidden completely'
        return `<div class="zone-row"><span class="dot-private"></span><span class="zone-meta">${esc(z.label || `Private place ${i + 1}`)}<small>${how}</small></span><button class="zone-del" data-action="del-noreport" data-i="${i}" aria-label="Delete">✕</button></div>`
      }).join('')
    : '<div class="note">None yet. A private place (like home) stays hidden — even in an emergency.</div>'
  return `
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><strong>Safe places</strong><button class="btn small" data-action="add-zone" data-kind="safe">＋ Add</button></div>
    <div class="note" style="margin-bottom:6px">Shared with everyone in ${esc(activeCircle()?.name ?? 'this circle')} — one person sets them up, every phone uses them.</div>
    <div class="zone-list">${safeList}</div>
    <div class="row" style="justify-content:space-between;margin:16px 0 8px"><strong>Private places</strong><button class="btn small" data-action="add-zone" data-kind="noreport">＋ Add</button></div>
    <div class="note" style="margin-bottom:6px">Yours alone — never leave this phone, apply in every circle.</div>
    <div class="zone-list">${privList}</div>
    ${offlineMapControl()}`
}

// The "save this area" control (see offlineArea.ts). Hidden until the feature flag
// is on (the extract service must be deployed first — see offlineMapEnabled).
function offlineMapControl(): string {
  if (!offlineMapEnabled()) return ''
  const hasZones = activeFences().length > 0 || persisted.noReportZones.length > 0
  const saved = offlineSavedBytes != null
  const mb = saved ? (offlineSavedBytes! / 1e6).toFixed(1) : ''
  const status = offlineSaving
    ? '<span class="muted">Saving…</span>'
    : saved ? `<span class="muted">Saved · ${mb} MB · works offline</span>` : '<span class="muted">Not saved</span>'
  const buttons = offlineSaving
    ? '<button class="btn small" disabled>Saving…</button>'
    : saved
      ? '<button class="btn small" data-action="save-offline-map">Update</button><button class="btn small ghost" data-action="remove-offline-map">Remove</button>'
      : `<button class="btn small primary" data-action="save-offline-map"${hasZones ? '' : ' disabled'}>Save map offline</button>`
  const help = hasZones
    ? 'Downloads the map around your places once — then it works with no signal, and privately (nobody sees when or where you look).'
    : 'Add a safe or private place first, then save its map for offline.'
  // Label language only bites on the offline vector map (raster tiles carry their own
  // labels), so only offer it once an area is saved. Default is each person's own
  // language; "Local names" shows what's on the street signs — handy when you're abroad.
  const labelMode = mapLabelMode()
  const labelToggle = saved ? `
    <div class="row" style="justify-content:space-between;margin:16px 0 6px"><strong>Map labels</strong></div>
    <div class="mode-toggle" role="group" aria-label="Map label language">
      <button data-action="map-labels" data-mode="device" aria-pressed="${labelMode === 'device'}">My language</button>
      <button data-action="map-labels" data-mode="local" aria-pressed="${labelMode === 'local'}">Local names</button>
    </div>
    <div class="note">${labelMode === 'local'
      ? 'Place names match the street signs — the same on everyone’s map.'
      : 'Place names in your device’s language where the map has them.'}</div>` : ''
  return `
    <div class="row" style="justify-content:space-between;margin:16px 0 8px"><strong>Offline map</strong>${status}</div>
    <div class="row" style="gap:10px">${buttons}</div>
    <div class="note">${help}</div>
    ${labelToggle}`
}

// ── Views: onboarding ────────────────────────────────────────────────────────
function onboardingView(): string {
  let inner: string
  if (onboardStep === 'create') {
    const ttlChip = (mode: string, label: string): string =>
      `<button class="btn small${ttlMode === mode ? ' primary' : ''}" data-action="ob-ttl" data-ttl="${mode}">${label}</button>`
    const pick = (mode: Mode, title: string, desc: string): string =>
      `<button class="pick${onboardMode === mode ? ' on' : ''}" data-action="ob-mode" data-mode="${mode}" aria-pressed="${onboardMode === mode}"><strong>${title}</strong><span>${desc}</span></button>`
    inner = `
      <h1>New circle</h1>
      <p class="tagline">Give it a name, choose how it shares, and how long it lasts.</p>
      <div class="field" style="text-align:left;margin-bottom:14px"><label for="cname">Name</label><input class="input" id="cname" placeholder="The Smiths · Lads' trip · Sat night" /></div>
      <div class="field" style="text-align:left;margin-bottom:8px"><label>How it shares</label></div>
      <div class="share-pick" style="margin-bottom:18px">
        ${pick('family', 'Private', 'Hidden until you ask for help, ask for a pick-up, or leave a safe place.')}
        ${pick('nightout', 'Share live', 'Friends see roughly where you are — handy for "who\'s still out?".')}
      </div>
      <div class="field" style="text-align:left;margin-bottom:6px"><label>How long</label></div>
      <div class="chip-row" role="group" aria-label="Lifetime" style="margin-bottom:10px;justify-content:center">
        ${ttlChip('ongoing', 'Ongoing')}${ttlChip('today', 'Today')}${ttlChip('custom', 'Custom')}
      </div>
      <div id="ob-ttl-custom" class="row" style="gap:8px;justify-content:center;margin-bottom:22px"${ttlMode === 'custom' ? '' : ' hidden'}>
        <input class="input" id="ttl-num" type="number" min="1" max="60" value="3" style="max-width:84px" />
        <select class="input" id="ttl-unit" style="max-width:120px"><option value="hours">hours</option><option value="days" selected>days</option></select>
      </div>
      <div class="actions">
        <button class="btn primary" data-action="do-create">Create circle</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'join') {
    inner = `
      <h1>Join a circle</h1>
      <p class="tagline">Paste an invite code, or join remotely by sharing your key.</p>
      <div class="field" style="text-align:left;margin-bottom:16px"><label for="jcode">Invite code</label><textarea class="input" id="jcode" rows="3" placeholder="Paste code…"></textarea></div>
      <div class="actions">
        <button class="btn primary" data-action="do-join">Join with code</button>
        <button class="btn" data-action="join-remote">Join remotely (share my key)</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'restore') {
    inner = `
      <h1>Restore from backup</h1>
      <p class="tagline">Paste your backup code and unlock it with its passphrase — your key and circles come back exactly as they were.</p>
      <div class="field" style="text-align:left;margin-bottom:12px"><label for="restore-code">Backup code</label><textarea class="input" id="restore-code" rows="4" placeholder="Paste backup code…"></textarea></div>
      <div class="field" style="text-align:left;margin-bottom:16px"><label for="restore-pass">Passphrase</label><input class="input" id="restore-pass" type="password" autocomplete="current-password" /></div>
      <div class="actions">
        <button class="btn primary" data-action="do-restore">Restore</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else if (onboardStep === 'await') {
    const np = persisted.identity ? fullNpub(persisted.identity.pk) : ''
    inner = `
      <h1>Join remotely</h1>
      <p class="tagline">Share your key with whoever's inviting you. You'll join automatically when they send the invite.</p>
      <div class="qr" id="qr-npub"></div>
      <div class="invite-code" id="my-npub">${esc(np)}</div>
      <div class="actions">
        <button class="btn primary" data-action="copy-npub">Copy my key</button>
        <button class="btn ghost" data-action="back">Cancel</button>
      </div>
      <div class="note" style="margin-top:12px">⟳ Waiting for a secure invite…</div>
      ${awaitSince && Date.now() - awaitSince > AWAIT_GUIDE_MS
        ? '<div class="note" style="margin-top:8px">Still waiting — check the inviter has your key and has tapped “Send encrypted invite”. It can take a minute on a slow connection. Or cancel and ask them for an invite code instead.</div>'
        : ''}`
  } else if (adding) {
    inner = `
      <h1>Add a circle</h1>
      <p class="tagline">Create another circle or join one — you can be in many at once: family, a trip, a night out.</p>
      <div class="actions">
        <button class="btn primary" data-action="create">Create a circle</button>
        <button class="btn" data-action="join">Join with a code</button>
        <button class="btn ghost" data-action="join-remote">Join remotely (share my key)</button>
        <button class="btn ghost" data-action="cancel-add">Cancel</button>
      </div>`
  } else {
    const signedInSignet = persisted.authMethod === 'signet' && persisted.identity
    const signetRow = signedInSignet
      ? '<div class="note" style="margin-top:16px">✓ Signed in with Signet — your key stays in your signer</div>'
      : '<button class="btn ghost" data-action="signet" style="margin-top:10px">Sign in with Signet</button>'
    inner = `
      <img class="hero-logo" src="./icon.svg" alt="" />
      <h1>Stay close,<br/>stay private.</h1>
      <p class="tagline">Your location stays hidden — shared only when you ask for a pick-up, raise help, or step outside a safe area.</p>
      <div class="actions">
        <button class="btn primary" data-action="create">Create a circle</button>
        <button class="btn ghost" data-action="join">Join with a code</button>
        <button class="btn ghost" data-action="restore">Restore from backup</button>
        ${signetRow}
      </div>`
  }
  return `<main class="screen onboard fade-in">${inner}</main><div class="toast" id="toast"></div>`
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function wireOnboard(): void {
  if (onboardStep === 'await') {
    const qrEl = document.getElementById('qr-npub')
    if (qrEl && persisted.identity) {
      try {
        const qr = qrcode(0, 'M')
        // A link, never bare text (same lesson as the join QR): the inviter's camera
        // opens flock with this key already filled into the send-invite form.
        qr.addData(`${location.origin}/#invite=${fullNpub(persisted.identity.pk)}`)
        qr.make()
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
      } catch { qrEl.remove() }
    }
  }
  root.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => {
      const a = node.getAttribute('data-action')
      if (a === 'create') { onboardStep = 'create'; rerenderOnboard() }
      else if (a === 'join') { onboardStep = 'join'; rerenderOnboard() }
      else if (a === 'restore') { onboardStep = 'restore'; rerenderOnboard() }
      else if (a === 'do-restore') void doRestore()
      else if (a === 'back') { onboardStep = 'intro'; awaitingInvite = false; rerenderOnboard() }
      else if (a === 'ob-mode') {
        // Flip the behaviour in place. A full re-render here would discard whatever's
        // half-typed in the #cname field (it's uncontrolled, read only on create).
        onboardMode = (node as HTMLElement).dataset.mode as Mode
        root.querySelectorAll<HTMLElement>('[data-action="ob-mode"]').forEach((b) => {
          const on = b.dataset.mode === onboardMode
          b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on))
        })
      }
      else if (a === 'ob-ttl') {
        // Update in place too, for the same reason as ob-mode.
        ttlMode = (node as HTMLElement).dataset.ttl as 'ongoing' | 'today' | 'custom'
        root.querySelectorAll<HTMLElement>('[data-action="ob-ttl"]').forEach((b) => b.classList.toggle('primary', b.dataset.ttl === ttlMode))
        const cust = document.getElementById('ob-ttl-custom')
        if (cust) (cust as HTMLElement).hidden = ttlMode !== 'custom'
      }
      else if (a === 'cancel-add') { adding = false; onboardStep = 'intro'; render() }
      else if (a === 'do-create') doCreate()
      else if (a === 'do-join') doJoin()
      else if (a === 'join-remote') doJoinRemote()
      else if (a === 'copy-npub') copyNpub()
      else if (a === 'signet') void doSignetLogin()
    })
  })
}
function rerenderOnboard(): void { root.innerHTML = onboardingView(); wireOnboard() }

function wireApp(): void {
  const qrEl = document.getElementById('qr')
  const ac = activeCircle()
  if (qrEl && ac) {
    try {
      const qr = qrcode(0, 'M')
      // A LINK, never bare text: camera apps open links, but bare text they offer
      // to web-search — which would hand the seed to a search engine (see inviteLink).
      qr.addData(store.inviteLink(ac, location.origin))
      qr.make()
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
    } catch { qrEl.remove() }
  }
  root.querySelectorAll('[data-action]').forEach((node) => {
    if ((node as HTMLElement).closest('#map-panel')) return // wired by wireMapPanel
    const action = node.getAttribute('data-action') as string
    if (action === 'sos-hold') { wireSos(node as HTMLElement); return }
    if (action === 'spoken-reveal') { wireDuressReveal(node as HTMLElement); return }
    // Coercion points: a silent long-press on these performs the identical visible
    // action AND raises a covert help alarm — or, for "I'm safe now", sends a
    // coerced all-clear the circle ignores (see wasCovertHold / FLOCK.md §6.1).
    if (action === 'toggle-share' || action === 'disarm-checkin' || action === 'do-dark' || action === 'im-safe') {
      node.addEventListener('pointerdown', () => beginHold(action))
    }
    node.addEventListener('click', () => handleAction(action, node as HTMLElement))
  })
  if (tab === 'map') void initMap()
}

// ── Map controller ───────────────────────────────────────────────────────────
async function initMap(): Promise<void> {
  mapView?.destroy()
  const container = document.getElementById('map')
  if (!container) return
  const { MapView } = await import('./map') // lazy — keeps maplibre out of the main bundle
  mapView = await MapView.create(container, fix ?? undefined, { circleId: activeCircle()?.id })
  if (import.meta.env.DEV) (window as unknown as { flockMapView?: unknown }).flockMapView = mapView // e2e seam (dev only)
  mapView.setGeofences(activeFences())
  mapView.setNoReportZones(persisted.noReportZones)
  mapView.onMove(() => { if (addMode) updatePreview() })
  updateMapData()
  wireMapPanel()
  requestAnimationFrame(() => mapView?.map.resize())
  if (offlineMapEnabled()) void refreshOfflineState()
  if (!fix) void centreOnCurrentPosition() // no live share yet → actively locate for the map
}

// Centre the map on the user's current position without starting a share. Purely
// local (nothing is broadcast); silently does nothing if permission is denied or
// the user has since started placing a zone (we must not yank the view then).
async function centreOnCurrentPosition(): Promise<void> {
  const f = await svc.currentPosition()
  if (f && mapView && !addMode) mapView.flyTo({ lat: f.lat, lon: f.lon }, { instant: true })
}

// ── Offline map ("save this area") ───────────────────────────────────────────
// Off by default until the extract service (server/extract.mjs) is deployed to the
// host; enable with VITE_OFFLINE_MAP=1 or localStorage 'flock.offlinemap'='1'.
function offlineMapEnabled(): boolean {
  if (import.meta.env.VITE_OFFLINE_MAP === '1') return true
  try { return localStorage.getItem('flock.offlinemap') === '1' } catch { return false }
}

async function refreshOfflineState(): Promise<void> {
  const id = activeCircle()?.id
  const oa = await import('./offlineArea')
  offlineSavedBytes = id ? (await oa.savedAreaInfo(id))?.bytes ?? null : null
  offlineBBox = id ? await oa.savedAreaBBox(id) : null
  renderMapPanel()
  updateMapData() // re-evaluate the out-of-area chip against the loaded bounds
}

async function saveOfflineMap(): Promise<void> {
  const id = activeCircle()?.id
  if (!id || offlineSaving) return
  offlineSaving = true
  renderMapPanel()
  try {
    const { saveArea } = await import('./offlineArea')
    const r = await saveArea(id, activeFences(), persisted.noReportZones)
    offlineSavedBytes = r?.bytes ?? offlineSavedBytes
    offlineSaving = false
    await initMap() // re-init so the map now renders from the saved OPFS basemap
  } catch {
    offlineSaving = false
    toast('Could not save the map — is the extract service running?')
    renderMapPanel()
  }
}

async function removeOfflineMap(): Promise<void> {
  const id = activeCircle()?.id
  if (!id) return
  await (await import('./offlineArea')).removeSavedArea(id)
  offlineSavedBytes = null
  await initMap()
}

// Switch the offline map's labels between the device language and local/native names.
// Re-init so the vector style rebuilds with the new language (same pattern as save/remove).
async function setMapLabels(mode: MapLabelMode): Promise<void> {
  if (mode !== 'device' && mode !== 'local') return
  if (mapLabelMode() === mode) return
  setMapLabelMode(mode)
  renderMapPanel()
  await initMap()
}

function wireMapPanel(): void {
  const slider = document.getElementById('radius') as HTMLInputElement | null
  if (slider) {
    slider.addEventListener('input', () => {
      addRadius = Number(slider.value)
      const l = document.getElementById('radius-label')
      if (l) l.textContent = `${addRadius} m`
      updatePreview()
    })
  }
  document.querySelectorAll('#map-panel [data-action]').forEach((n) => {
    n.addEventListener('click', () => handleAction(n.getAttribute('data-action') as string, n as HTMLElement))
  })
}

function renderMapPanel(): void {
  const panel = document.getElementById('map-panel')
  if (panel) panel.innerHTML = mapPanelInner()
  const ch = document.getElementById('crosshair')
  if (ch) (ch as HTMLElement).hidden = !addMode && !rzvPick
  wireMapPanel()
}

function updatePreview(): void {
  if (!mapView) return
  const c = mapView.center()
  mapView.setPreview({ kind: 'circle', centre: { lat: c.lat, lon: c.lon }, radiusMetres: addRadius } as CircleGeofence)
}

function memberPoints(): MapPoint[] {
  const me = persisted.identity?.pk
  const st = active()
  if (!st) return []
  return classifyPresence([...st.beacons.values()], nowSec(), { staleAfterSeconds: 600 }).map((e) => {
    const d = decode(e.geohash)
    const precision = st.beacons.get(e.member)?.precision
    return {
      member: e.member,
      lat: d.lat,
      lon: d.lon,
      label: e.member === me ? 'You' : pinLabel(e.member),
      status: st.alerts.has(e.member) ? 'alert' as const : e.status,
      // Show the disclosed area at its true precision, so a coarse share reads as
      // "roughly here" rather than a deceptively exact pin.
      ...(precision ? { radiusMetres: precisionToRadius(precision) } : {}),
    }
  })
}
function updateMapData(): void {
  const st = active()
  const me = persisted.identity?.pk
  const r = st?.rendezvous
  // While the proposer is running a meeting search (no rendezvous yet), the
  // contributor cells take over the map — the same people at the same coarse cells,
  // so drawing presence too would just double every blob (see setContributorPins).
  const runningMeeting = !!(st && st.meeting && st.meeting.setBy === me && !r)
  const pts = runningMeeting ? [] : memberPoints()
  mapView?.setMembers(pts)
  mapView?.setRendezvous(r ? { lat: r.place.lat, lon: r.place.lon, label: r.place.label || r.place.address?.split(',')[0] } : null)
  // Meeting-point overlays — each contributor's cell at its disclosed precision + the
  // suggested venue, so the proposer can eyeball the inputs and the pick on the map.
  let shown = pts
  if (runningMeeting && st) {
    const contrib: MapPoint[] = [...st.meetingShares.values()].map((s) => {
      const d = decode(s.geohash)
      return {
        member: s.member, lat: d.lat, lon: d.lon,
        label: s.member === me ? 'You' : pinLabel(s.member),
        status: 'active' as const, radiusMetres: precisionToRadius(s.precision),
      }
    })
    mapView?.setContributorPins(contrib)
    const v = st.meetingSuggestion?.venue
    mapView?.setMeetingVenue(v ? { lat: v.lat, lon: v.lon, label: v.venueType === 'centroid' ? 'Fair spot' : v.name } : null)
    shown = contrib
  } else {
    mapView?.setContributorPins([])
    mapView?.setMeetingVenue(null)
  }
  // Out-of-area chip: in offline mode, flag any shown pin beyond the saved map's
  // bounds. We never live-fetch to cover it — leaking a viewport mid-event is wrong.
  const el = document.getElementById('offline-oob')
  if (!el) return
  const bbox = offlineBBox
  const outside = bbox ? shown.filter((p) => !bboxContains(bbox, p.lat, p.lon)) : []
  el.hidden = outside.length === 0
  if (outside.length) el.textContent = `⚠ ${outside.length} ${outside.length === 1 ? 'pin' : 'pins'} outside your saved map`
}

function saveZone(): void {
  if (!mapView) return
  const c = mapView.center()
  const area: CircleGeofence = { kind: 'circle', centre: { lat: c.lat, lon: c.lon }, radiusMetres: addRadius }
  if (addZoneKind === 'noreport') {
    const zone: NoReportZone = { area, policy: newZonePolicy, label: `Private place ${persisted.noReportZones.length + 1}` }
    persisted.noReportZones = [...persisted.noReportZones, zone]
    toast('Private place added — it stays hidden')
  } else {
    setActiveFences([...activeFences(), area])
    toast('Safe place added')
  }
  store.save(persisted)
  addMode = false
  addZoneKind = 'safe'
  mapView.setPreview(null)
  mapView.setGeofences(activeFences())
  mapView.setNoReportZones(persisted.noReportZones)
  renderMapPanel()
}

function delZone(i: number): void {
  setActiveFences(activeFences().filter((_, idx) => idx !== i))
  mapView?.setGeofences(activeFences())
  renderMapPanel()
}

function delNoReport(i: number): void {
  persisted.noReportZones = persisted.noReportZones.filter((_, idx) => idx !== i)
  store.save(persisted)
  mapView?.setNoReportZones(persisted.noReportZones)
  renderMapPanel()
}

/** Re-render without tearing down a live map. */
function refresh(): void {
  // Never rebuild while an onboarding / add-circle form is on screen — a background
  // refresh would discard a half-typed circle name (the inputs are uncontrolled).
  if (adding || !persisted.identity || !activeCircle()) return
  if (tab === 'map' && mapView) { updateMapData(); renderMapPanel() }
  else render()
}

// ── Signer (LocalSigner or SignetSigner) ─────────────────────────────────────
let _signer: FlockSigner | null = null
let _signerFor = ''
let signetSigner: FlockSigner | null = null // live Signet signer (from login/restore)
function getSigner(): FlockSigner | null {
  if (persisted.authMethod === 'signet') return signetSigner
  const id = persisted.identity
  if (!id?.skHex) { _signer = null; _signerFor = ''; return null }
  if (_signer && _signerFor === id.skHex) return _signer
  _signer = makeLocalSigner(id.skHex)
  _signerFor = id.skHex
  return _signer
}

async function doSignetLogin(): Promise<void> {
  try {
    const session = await signetLogin({ appName: 'flock', relayUrl: PRIVATE_RELAYS[0] })
    if (!session) { toast('Sign-in cancelled'); return }
    if (!session.signer.capabilities.hasNip44) { toast("That sign-in app isn't compatible — try another"); return }
    signetSigner = makeSignetSigner(session.signer)
    persisted.identity = { pk: session.pubkey }
    persisted.authMethod = 'signet'
    store.save(persisted)
    onboardStep = 'intro'
    toast(`Signed in${session.displayName ? ` as ${session.displayName}` : ''}`)
    render()
  } catch { toast('Sign-in failed') }
}

/** On reload, rehydrate the Signet signer from its stored session. */
async function restoreSignet(): Promise<void> {
  if (persisted.authMethod !== 'signet' || signetSigner) return
  try {
    const session = await signetRestore()
    if (session) { signetSigner = makeSignetSigner(session.signer); render() }
  } catch { /* leave unsigned; user can re-auth */ }
}

/** Publish a flock signal as a gift-wrap to the circle's shared inbox (relay sees only kind:1059). */
async function publishSignal(unsigned: { kind: number; content: string; tags: string[][]; created_at?: number }, circle: store.Circle | null = activeCircle()): Promise<void> {
  const signer = getSigner()
  if (!circle || !signer) return
  const inbox = deriveInbox(circle.seedHex)
  const wrap = await giftWrap(signer, inbox.pk, unsigned)
  await svc.publishSigned(persisted.relayUrls, wrap as never)
}

// ── Members, invites & reseed ────────────────────────────────────────────────
function members(): string[] { return activeCircle()?.members ?? [] }

// ── Safe places (per-circle, synced) ─────────────────────────────────────────
function activeFences(): Geofence[] { return activeCircle()?.geofences ?? [] }

/** Apply a local safe-place edit and sync the full set to the circle.
 *  The clock is forced strictly past the last applied edit, so two same-second
 *  edits by the same person still read as newer on every other device. */
function setActiveFences(fences: Geofence[]): void {
  const c = activeCircle()
  if (!c) return
  const by = persisted.identity?.pk
  const updatedAt = Math.max(nowSec(), (c.fencesUpdatedAt ?? 0) + 1)
  patchCircleById(c.id, { geofences: fences, fencesUpdatedAt: updatedAt, ...(by ? { fencesBy: by } : {}) })
  if (by) void publishFences({ ...c, geofences: fences, fencesUpdatedAt: updatedAt, fencesBy: by })
}

/** Broadcast a circle's current safe-place set (group-envelope + gift wrap). */
async function publishFences(c: store.Circle): Promise<void> {
  const by = c.fencesBy ?? persisted.identity?.pk
  if (!by || c.fencesUpdatedAt === undefined) return
  try {
    const set = { fences: c.geofences ?? [], updatedAt: c.fencesUpdatedAt, by }
    await publishSignal(await buildFencesSignal({ groupId: c.id, seedHex: c.seedHex, set }), c)
  } catch { toast("Couldn't sync safe places — they're saved here and will sync on your next edit") }
}

function ensureMember(circle: store.Circle, pk: string, expected = false): void {
  // Re-read the live roster rather than trusting the captured `circle`: two
  // first-contact signals arriving together each `await` decryption, and a stale
  // members snapshot would let the later write clobber the earlier one — silently
  // dropping a member (who would then be skipped by reseeds and lists).
  const current = persisted.circles.find((c) => c.id === circle.id)
  if (!current) return
  const patch = store.withNewMember(current, pk, nowSec(), { expected: expected || pk === persisted.identity?.pk })
  if (!patch) return
  patchCircleById(circle.id, patch)
  // Seed possession = membership, so a leaked invite code grants a SILENT member.
  // Surface every unexpected roster addition until it's acknowledged (FLOCK §6).
  if (patch.unseenMembers) toast(`〰️ A new phone joined ${current.name}`)
  // Bounded retention (FLOCK §6.6): stored wraps expire, so a newcomer may never
  // get the fence set from relay replay — its author starts a fresh window for them.
  const live = persisted.circles.find((c) => c.id === circle.id)
  if (live?.fencesBy && live.fencesBy === persisted.identity?.pk) void publishFences(live)
}

function ensureInviteSub(): void {
  const id = persisted.identity
  if (!id) { stopInviteSub?.(); stopInviteSub = null; inviteSubKey = ''; return }
  const key = `${id.pk}@${persisted.relayUrls.join(',')}`
  if (key === inviteSubKey && stopInviteSub) return
  stopInviteSub?.()
  inviteSubKey = key
  // Listen on our derived personal-inbox tag, not our npub — the relay never sees a real key.
  stopInviteSub = svc.subscribeGiftWraps(persisted.relayUrls, personalInboxTag(id.pk), (e) => { void onInviteWrap(e) })
}

async function onInviteWrap(e: { pubkey: string; content: string; tags: string[][] }): Promise<void> {
  const signer = getSigner()
  if (!signer) return
  const payload = await readInvite(signer, e)
  if (!payload) {
    // Not an invite/reseed — maybe a targeted EXACT meeting share to my personal inbox.
    const exact = await readMeetingExactWrap(signer, e)
    if (exact) await onExactMeetingShare(exact)
    return
  }
  if (payload.t === 'invite') {
    if (persisted.circles.some((c) => c.id === payload.id)) return // already a member
    upsertCircle({
      id: payload.id, seedHex: payload.s, name: payload.n, mode: payload.m,
      members: [signer.pubkey], checkinInterval: 0, joinedAt: nowSec(), ...(payload.x ? { expiresAt: payload.x } : {}),
    }, true)
    awaitingInvite = false
    onboardStep = 'intro'
    adding = false
    tab = 'home'
    toast(`You've joined ${payload.n}`)
    render()
  } else if (payload.t === 'reseed') {
    const existing = persisted.circles.find((c) => c.id === payload.id)
    if (!existing) return
    patchCircleById(existing.id, { seedHex: payload.s })
    const st = cstate(existing.id)
    st.beacons.clear(); st.alerts.clear(); st.checkins.clear(); st.rzvStatuses.clear(); st.rendezvous = null; st.offgrid.clear()
    st.meeting = null; st.meetingShares.clear(); st.meetingSuggestion = null
    beaconCadence.delete(existing.id) // new key → re-emit promptly, don't inherit the old cell's heartbeat
    dropPresence(existing.id) // old-key pins are meaningless under the new seed
    toast("This circle's security was reset")
    refresh()
  }
}

// A contributor sent me (the proposer) their EXACT spot for a meeting I'm running —
// only I could decrypt it. Merge it (preferring the finer disclosure) and recompute.
async function onExactMeetingShare(share: MeetingShare): Promise<void> {
  const me = persisted.identity?.pk
  for (const c of persisted.circles) {
    const st = cstate(c.id)
    if (st.meeting?.id !== share.requestId || st.meeting.setBy !== me) continue // I'm the proposer of a live search
    if (mergeMeetingShare(st, share)) {
      await refreshMeetingSuggestion(c.id)
      refresh()
    }
    return
  }
}

async function sendInvite(): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  if (!c || !signer) return
  const raw = (document.getElementById('invite-npub') as HTMLInputElement | null)?.value?.trim()
  if (!raw) { toast('Paste their invite key first'); return }
  let pk: string
  try { pk = raw.startsWith('npub') ? store.npubToHex(raw) : raw } catch { toast("That doesn't look like an invite key — ask them to copy it again"); return }
  if (!/^[0-9a-f]{64}$/.test(pk)) { toast("That doesn't look like an invite key"); return }
  if (pk === signer.pubkey) { toast("That's your own key"); return }
  try {
    const wrap = await buildInviteWrap(signer, pk, { t: 'invite', id: c.id, s: c.seedHex, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) })
    await svc.publishSigned(persisted.relayUrls, wrap as never)
    ensureMember(c, pk, true) // I sent this invite — their arrival is not news to me
    pendingInviteNpub = null
    toast('Secure invite sent')
    render()
  } catch { toast('Could not send invite') }
}

async function reseedCircle(removePk?: string): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  if (!c || !signer) return
  persisted.circleRootHex ??= store.newSeed()
  const epoch = (c.epoch ?? 0) + 1
  const seed = deriveCircleSeed(persisted.circleRootHex, c.id, epoch)
  const recipients = (c.members ?? []).filter((pk) => pk !== signer.pubkey && pk !== removePk)
  try {
    if (recipients.length) {
      const wraps = await buildReseedWraps(signer, recipients, { t: 'reseed', id: c.id, s: seed, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) })
      for (const w of wraps) await svc.publishSigned(persisted.relayUrls, w as never)
    }
    patchCircleById(c.id, { seedHex: seed, epoch, members: (c.members ?? []).filter((pk) => pk !== removePk) })
    const st = cstate(c.id)
    st.beacons.clear(); st.alerts.clear(); st.checkins.clear(); st.rzvStatuses.clear(); st.rendezvous = null; st.offgrid.clear()
    st.meeting = null; st.meetingShares.clear(); st.meetingSuggestion = null
    beaconCadence.delete(c.id) // new key → re-emit promptly, don't inherit the old cell's heartbeat
    dropPresence(c.id) // old-key pins are meaningless under the new seed
    // Replay the safe-place set under the new key (same clock — an echo to current
    // members, but anyone joining after the reseed finds it on the new inbox).
    const reseeded = persisted.circles.find((x) => x.id === c.id)
    if (reseeded && reseeded.fencesUpdatedAt !== undefined) void publishFences(reseeded)
    toast(removePk ? 'Member removed — circle security reset' : 'Circle security reset')
    render()
  } catch { toast("Couldn't reset security — try again") }
}

// ── Check-in / dead-man's-switch ─────────────────────────────────────────────
async function sendCheckIn(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const interval = c.checkinInterval ?? 0
  try {
    const tmpl = await buildCheckInSignal({ groupId: c.id, seedHex: c.seedHex, member: id.pk, intervalSeconds: interval })
    await publishSignal(tmpl, c)
    const ck = cstate(c.id).checkins
    if (interval > 0) ck.set(id.pk, { member: id.pk, timestamp: nowSec(), intervalSeconds: interval })
    else ck.delete(id.pk)
    toast(interval > 0 ? "Checked in — you're OK" : 'Checked out')
  } catch { toast('Check-in failed') }
  refresh()
}

function armCheckin(intervalSeconds: number): void {
  if (!activeCircle()) return
  patchActive({ checkinInterval: intervalSeconds })
  armingCheckin = false
  startMonitor()
  void sendCheckIn()
}

function disarmCheckin(): void {
  if (!activeCircle()) return
  patchActive({ checkinInterval: 0 })
  void sendCheckIn() // broadcasts a stand-down (interval 0)
}

function evaluateCheckinAlarm(): void {
  const me = persisted.identity?.pk
  let missed = 0
  for (const c of persisted.circles) {
    // A member who pre-announced a break is *meant* to be quiet — never alarm on them.
    missed += missedCheckins(classifyCheckins([...cstate(c.id).checkins.values()], nowSec()))
      .filter((s) => s.member !== me && !memberDark(c.id, s.member)).length
  }
  const was = checkinAlert
  checkinAlert = missed > 0
  if (checkinAlert && !was) toast(`⚠ ${missed === 1 ? 'A member' : `${missed} members`} missed a check-in`)
}

function isEditing(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

function startMonitor(): void {
  if (monitorTimer) return
  monitorTimer = window.setInterval(() => {
    // Auto-resume a break the moment its timer runs out.
    if (persisted.offGridUntil && persisted.offGridUntil <= nowSec()) {
      persisted.offGridUntil = undefined
      store.save(persisted)
      syncWatch() // break timer elapsed → resume sampling if sharing
      toast('Break over — sharing back on')
    }
    const expired = sweepExpired()
    evaluateCheckinAlarm()
    if (expired && !adding) { toast('A temporary circle ended'); render(); return }
    if (!isEditing()) refresh()
  }, 30_000)
}

// ── Buzz ─────────────────────────────────────────────────────────────────────
async function sendBuzz(reason: string, target?: string): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const r = reason.trim()
  if (!r) { toast('Pick or type a reason'); return }
  try {
    const tmpl = await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, reason: r, ...(target ? { target } : {}) })
    await publishSignal(tmpl, c)
    toast(target ? 'Buzzed' : 'Buzzed everyone')
  } catch { toast('Buzz failed') }
}

function buzzBanner(): string {
  if (!activeBuzz) return ''
  const who = activeBuzz.from === persisted.identity?.pk ? 'You' : nameFor(activeBuzz.from)
  const where = activeBuzz.circle ? ` · ${esc(activeBuzz.circle)}` : ''
  return `<div class="buzz-banner${activeBuzz.mine ? ' for-me' : ''}" data-action="dismiss-buzz" role="alert">
    <span class="bz-icon">🔔</span>
    <span class="bz-text"><strong>${esc(who)}</strong> · ${esc(activeBuzz.reason)}${where}</span>
    <span class="bz-x">✕</span>
  </div>`
}

// ── Off-grid ("take a break") ─────────────────────────────────────────────────
/** Pre-announce a planned silence (or a cancel, when until<=now) to every circle. */
async function broadcastOffGrid(until: number, reason?: string): Promise<void> {
  const id = persisted.identity
  if (!id) return
  for (const c of persisted.circles) {
    try {
      const tmpl = await buildOffGridSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, until, ...(reason ? { reason } : {}) })
      await publishSignal(tmpl, c)
    } catch { /* best effort, per circle */ }
  }
}

function goDark(): void {
  let sec = darkDurSec
  if (sec === -1) {
    const n = Number((document.getElementById('dark-num') as HTMLInputElement | null)?.value) || 0
    sec = Math.max(1, Math.min(48, Math.round(n))) * 3600
  }
  const why = (document.getElementById('dark-why') as HTMLInputElement | null)?.value?.trim() || undefined
  const until = nowSec() + sec
  persisted.offGridUntil = until
  store.save(persisted)
  goingDark = false
  syncWatch() // stop burning GPS for a break that shares nothing
  toast('On a break — sharing paused')
  void broadcastOffGrid(until, why)
  render()
}

function comeBack(): void {
  persisted.offGridUntil = undefined
  store.save(persisted)
  syncWatch() // resume sampling if we were sharing before the break
  toast("You're back on")
  void broadcastOffGrid(nowSec()) // until≤now tells every circle the break is over
  render()
}

// ── Rendezvous ───────────────────────────────────────────────────────────────
function broadcastRzvStatus(): void {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !fix) return
  const st = cstate(c.id)
  if (!st.rendezvous) return
  const p = assessArrival(st.rendezvous, id.pk, { lat: fix.lat, lon: fix.lon }, travelMode, nowSec())
  st.rzvStatuses.set(id.pk, { rendezvousId: st.rendezvous.id, member: id.pk, status: p.status, etaSeconds: p.etaSeconds, timestamp: nowSec() })
  if (nowSec() - lastRzvStatus < 30) return
  lastRzvStatus = nowSec()
  const status = st.rzvStatuses.get(id.pk) as RendezvousStatus
  void (async () => {
    try { await publishSignal(await buildRendezvousStatusSignal({ groupId: c.id, seedHex: c.seedHex, status }), c) } catch { /* best effort */ }
  })()
}

// Build + broadcast a rendezvous from a resolved place. Shared by the typed path
// (geocode) and the map-pick path, so both go out over the relay identically.
async function shareRendezvous(place: Rendezvous['place']): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const r: Rendezvous = {
    id: `rzv-${nowSec().toString(36)}`,
    place,
    deadline: nowSec() + rzvDurationMin * 60,
    mode: c.mode === 'family' ? 'be-back' : 'meet-at',
    setBy: id.pk,
    createdAt: nowSec(),
  }
  try {
    await publishSignal(await buildRendezvousSignal({ groupId: c.id, seedHex: c.seedHex, rendezvous: r }), c)
    const cs = cstate(c.id)
    cs.rendezvous = r
    cs.rzvStatuses.clear()
    toast('Meeting point set')
    render()
  } catch { toast("Couldn't set the meeting point") }
}

async function setRendezvous(): Promise<void> {
  const q = (document.getElementById('rzv-place') as HTMLInputElement | null)?.value?.trim() ?? ''
  if (q) {
    toast('Finding the place…')
    const g = await geocode(q)
    if (!g) { toast("Couldn't find that — try a fuller address"); return }
    await shareRendezvous({ lat: g.lat, lon: g.lon, label: q, address: g.address, geohash: encode(g.lat, g.lon, 10) })
  } else if (fix) {
    await shareRendezvous({ lat: fix.lat, lon: fix.lon, geohash: encode(fix.lat, fix.lon, 10) })
  } else {
    toast('Type a place/address, or start sharing to use your spot')
  }
}

// Map-pick: pan the map so the crosshair sits on the meeting spot, then read the
// centre — the same idiom as the safe/private-place editor.
function pickRzvOnMap(): void {
  rzvPick = true
  addMode = false // never both crosshair modes at once
  tab = 'map'
  render()
}

async function setRzvFromMap(): Promise<void> {
  if (!mapView) return
  const c = mapView.center()
  rzvPick = false
  tab = 'circle'
  toast('Setting the meeting point…')
  const g = await reverseGeocode(c.lat, c.lon) // bounded, best-effort; null just means "no street address"
  await shareRendezvous({
    lat: c.lat,
    lon: c.lon,
    geohash: encode(c.lat, c.lon, 10),
    ...(g ? { label: g.address.split(',')[0], address: g.address } : {}),
  })
}

function cancelRzvPick(): void {
  rzvPick = false
  tab = 'circle'
  render()
}

function clearRendezvous(): void {
  const st = active()
  if (st) { st.rendezvous = null; st.rzvStatuses.clear() }
  render()
}

function copyRzvForTaxi(): void {
  const r = active()?.rendezvous
  if (!r) return
  const parts = [r.place.label, r.place.address, `${r.place.lat.toFixed(5)}, ${r.place.lon.toFixed(5)}`].filter(Boolean)
  navigator.clipboard?.writeText(parts.join(' — ')).then(() => toast('Copied — paste into your taxi app'), () => toast('Copy failed'))
}

// The live countdown to a rendezvous deadline. A dedicated 1 s ticker updates just
// the #rzv-countdown text — never a full re-render (that would fight input focus and
// waste work) — and only runs while a rendezvous is actually on screen (Circle tab),
// so it costs nothing the rest of the time (minimal-footprint north star).
function countdownLabel(dueInSeconds: number): string {
  return dueInSeconds > 0 ? `in ${formatCountdown(dueInSeconds)}` : 'now'
}

function tickRzvCountdown(): void {
  const r = active()?.rendezvous
  const el = document.getElementById('rzv-countdown')
  if (!r || !el) { syncRzvTicker(); return } // rendezvous or screen gone → wind down
  const dueIn = r.deadline - nowSec()
  el.textContent = countdownLabel(dueIn)
  el.classList.toggle('overdue', dueIn <= 0)
}

function syncRzvTicker(): void {
  const want = tab === 'circle' && !adding && !!activeCircle() && !!active()?.rendezvous
  if (want && !rzvTicker) rzvTicker = window.setInterval(tickRzvCountdown, 1000)
  else if (!want && rzvTicker) { clearInterval(rzvTicker); rzvTicker = 0 }
}

// ── Meeting point — the "where" of Phase F ────────────────────────────────────
// "Some of us are in one bar, some in another — where do we all go?" A member
// proposes; each other member may opt in and contribute a COARSE spot; the
// proposer's device computes a fair midpoint on-device and turns it into an
// ordinary rendezvous. Coordinates never leave except as a neighbourhood geohash
// cell, and only from those who actively tap "share" (withhold-by-default holds).
const MEETING_PRECISION = 6 // geohash chars ≈ neighbourhood; exactly policy's `coarse`
const MEETING_EXACT_PRECISION = 9 // geohash chars ≈ 5 m; the "Exact" rung, shared only with a named individual
const MEETING_TIME_BUDGET_MIN = 30 // reachability budget for the on-device isochrones
const VENUE_SEARCH_RADIUS_M = 1500 // hunt for real venues within ~18 min walk of the fair point
// Human labels for the fairness strategies (design doc). Only offered when there
// are ≥2 candidate venues to balance between — with one spot, there's no choice.
const FAIRNESS_OPTIONS: ReadonlyArray<readonly [FairnessStrategy, string]> = [
  ['min_max', 'Fairest'],
  ['min_total', 'Least total'],
  ['min_variance', 'Most equal'],
]
const kitMode = (m: TravelMode): TransportMode => (m === 'transit' ? 'public_transit' : m)

async function proposeMeeting(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const request: MeetingRequest = {
    id: `mtg-${nowSec().toString(36)}`,
    setBy: id.pk,
    mode: travelMode,
    maxTimeMinutes: MEETING_TIME_BUDGET_MIN,
    createdAt: nowSec(),
  }
  const cs = cstate(c.id)
  cs.meeting = request
  cs.meetingShares.clear()
  cs.meetingSuggestion = null
  try {
    await publishSignal(await buildMeetingRequestSignal({ groupId: c.id, seedHex: c.seedHex, request }), c)
    toast('Asking everyone for a rough spot')
    render()
    await contributeMeetingShare() // the proposer opts in too — my own coarse spot, if I have a fix
  } catch { toast('Could not start the meeting-point search') }
}

// Publish my COARSE spot toward the active request. Shared by "propose" (proposer
// auto-contributes) and the explicit "Share my spot" button. Coarsening to a
// neighbourhood geohash cell happens here at the edge — the exact fix never leaves.
async function contributeMeetingShare(exact = false): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  const cs = c ? cstate(c.id) : null
  if (!c || !id || !cs?.meeting) return
  const f = fix
  if (!f) { toast('Turn on sharing so we can use your rough spot'); return }
  const share: MeetingShare = { requestId: cs.meeting.id, member: id.pk, geohash: encode(f.lat, f.lon, MEETING_PRECISION), precision: MEETING_PRECISION, mode: travelMode, timestamp: nowSec() }
  try {
    // The group inbox always gets only the coarse neighbourhood cell.
    await publishSignal(await buildMeetingShareSignal({ groupId: c.id, seedHex: c.seedHex, share }), c)
    mergeMeetingShare(cs, share)
    // Opt-in: ALSO send my EXACT spot, gift-wrapped to the proposer's personal inbox
    // — only they can decrypt it; the rest of the group still sees only the cell.
    if (exact && cs.meeting.setBy !== id.pk) {
      const signer = getSigner()
      if (signer) {
        const exactShare: MeetingShare = { requestId: cs.meeting.id, member: id.pk, geohash: encode(f.lat, f.lon, MEETING_EXACT_PRECISION), precision: MEETING_EXACT_PRECISION, mode: travelMode, timestamp: nowSec() }
        try {
          await svc.publishSigned(persisted.relayUrls, await buildMeetingExactWrap(signer, cs.meeting.setBy, exactShare) as never)
          toast(`Shared your exact spot with ${nameFor(cs.meeting.setBy)}`)
        } catch { /* best effort — the coarse share already reached the group */ }
      }
    }
    await refreshMeetingSuggestion(c.id)
    render()
  } catch { toast('Could not share your spot') }
}

// Declining contributes nothing — this only hides the prompt on my own device.
function dismissMeeting(): void {
  const m = active()?.meeting
  if (m) meetingDismissed.add(m.id)
  render()
}

// The proposer's device recomputes the fair point whenever the contributions
// change (≥2 needed). Purely on-device: each coarse geohash is decoded back to its
// cell centre and fed to the isochrone/fairness maths — no network, no raw coords.
async function refreshMeetingSuggestion(circleId: string): Promise<void> {
  const st = cstate(circleId)
  const me = persisted.identity?.pk
  if (!st.meeting || st.meeting.setBy !== me || st.meetingShares.size < 2) return
  const reqId = st.meeting.id
  const gen = ++st.meetingGen // newest refresh wins; a slow venue fetch must not clobber it
  st.meetingVenues = [] // re-fetched below; empty meanwhile so the fairness toggle stays hidden
  const opts = { mode: kitMode(st.meeting.mode), maxTimeMinutes: st.meeting.maxTimeMinutes, fairness: meetingFairness }
  const participants = meetingParticipants(st)
  const live = () => st.meetingGen === gen && st.meeting?.id === reqId // not superseded/cancelled
  try {
    // 1) The on-device fair point — instant, no network. Show it if nothing's up
    //    yet (don't downgrade a venue already on screen while we re-fetch).
    const [centroid] = await suggestMeetingPoint(participants, opts)
    if (!live()) return
    if (!st.meetingSuggestion) { st.meetingSuggestion = centroid ?? null; render() }
    if (!centroid) return
    // 2) Best-effort upgrade to real, named venues everyone can reach. Only a
    // bounding box around the fair point leaves the device (venues.ts); on any
    // failure — proxy down, rate-limited, no matches — we keep the centroid. Cache
    // the venues so the fairness toggle can re-rank them without another fetch.
    const region = circleToPolygon([centroid.venue.lon, centroid.venue.lat], VENUE_SEARCH_RADIUS_M)
    const venues = await searchMeetingVenues(region)
    if (!live()) return
    st.meetingVenues = venues
    const [best] = rankVenues(participants, venues, opts)
    st.meetingSuggestion = best ?? centroid
    render()
  } catch { /* best effort — keep the last good suggestion on screen */ }
}

// The decoded coarse cells of everyone who's shared, as reachability inputs. Each
// geohash-6 cell is decoded to its centre — the coarse spot, never a raw fix.
function meetingParticipants(st: CircleState): Array<{ lat: number; lon: number; label: string }> {
  return [...st.meetingShares.values()].map((s) => {
    const d = decode(s.geohash)
    return { lat: d.lat, lon: d.lon, label: nameFor(s.member) }
  })
}

// Store a contribution, preferring the FINER disclosure when we already hold one for
// this member — an exact share (gift-wrapped to me, the proposer) must not be
// overwritten by a coarser group-inbox echo arriving later, whichever order they
// land in. Returns whether anything changed (so the caller can skip a recompute).
function mergeMeetingShare(st: CircleState, share: MeetingShare): boolean {
  const existing = st.meetingShares.get(share.member)
  if (existing && share.precision < existing.precision) return false
  st.meetingShares.set(share.member, share)
  return true
}

// Re-rank the already-fetched venues under the current fairness strategy — NO
// network (the toggle only reorders what we already hold). Falls back to the
// on-device centroid when no venues were found.
async function applyMeetingRanking(circleId: string): Promise<void> {
  const st = cstate(circleId)
  const me = persisted.identity?.pk
  if (!st.meeting || st.meeting.setBy !== me || st.meetingShares.size < 2) return
  const opts = { mode: kitMode(st.meeting.mode), maxTimeMinutes: st.meeting.maxTimeMinutes, fairness: meetingFairness }
  const participants = meetingParticipants(st)
  const [best] = rankVenues(participants, st.meetingVenues, opts)
  if (best) { st.meetingSuggestion = best; render(); return }
  const [centroid] = await suggestMeetingPoint(participants, opts) // on-device only, no network
  st.meetingSuggestion = centroid ?? null
  render()
}

// The proposer picks how to balance travel across the group. Persisted; re-ranks
// the venues already on screen in place (see applyMeetingRanking) — no re-fetch.
function setMeetingFairness(fair: FairnessStrategy): void {
  meetingFairness = fair
  try { localStorage.setItem('flock.fairness', fair) } catch { /* localStorage may be unavailable */ }
  const c = activeCircle()
  if (c) void applyMeetingRanking(c.id)
  render()
}

// Pick the fair point → it becomes an ordinary rendezvous (everyone gets the pin +
// countdown via the machinery already built). Setting it supersedes the search.
async function setMeetingAsRendezvous(): Promise<void> {
  const cs = active()
  const s = cs?.meetingSuggestion
  if (!cs || !s) return
  const { lat, lon } = s.venue
  const isVenue = s.venue.venueType !== 'centroid'
  cs.meeting = null
  cs.meetingShares.clear()
  cs.meetingSuggestion = null
  toast('Setting the meeting point…')
  const g = await reverseGeocode(lat, lon) // bounded, best-effort; fills the taxi address
  // A real venue names itself; a bare centroid borrows the geocoded street/road.
  const label = isVenue ? s.venue.name : (g ? g.address.split(',')[0] : 'Meeting point')
  await shareRendezvous({
    lat,
    lon,
    geohash: encode(lat, lon, 10),
    label,
    ...(g ? { address: g.address } : {}),
  })
}

function cancelMeeting(): void {
  const cs = active()
  if (cs) { cs.meeting = null; cs.meetingShares.clear(); cs.meetingSuggestion = null }
  render()
}

// The meeting-point flow card — shown in place of the rendezvous setup while a
// search is live. Contributors opt in; once ≥2 are in, the proposer sees the fair
// point and can turn it into the rendezvous.
function meetingCard(): string {
  const me = persisted.identity?.pk
  const cs = active()
  const m = cs?.meeting
  if (!cs || !m || cs.rendezvous) return '' // a set rendezvous always wins the display
  const iProposed = m.setBy === me
  const iShared = !!me && cs.meetingShares.has(me)
  const dismissed = meetingDismissed.has(m.id)
  const count = cs.meetingShares.size

  const proposerName = esc(nameFor(m.setBy))
  const prompt = (!iShared && !dismissed)
    ? `<div class="note">Share a rough spot (neighbourhood only) so we can pick somewhere fair.</div>
       <div class="row" style="gap:10px;flex-wrap:wrap">
         <button class="btn small primary" data-action="share-meeting">Share my spot</button>
         ${!iProposed ? `<button class="btn small" data-action="share-meeting-exact">Exact, only to ${proposerName}</button>` : ''}
         <button class="btn small ghost" data-action="dismiss-meeting">Not now</button>
       </div>
       ${!iProposed ? `<div class="note" style="font-size:12px;opacity:0.85">“Exact” shares your precise spot with ${proposerName} alone — the group still sees only your neighbourhood.</div>` : ''}`
    : `<div class="note">${count === 1 ? '1 person has' : `${count} people have`} shared a rough spot${iShared ? " — you're in" : ''}.</div>`

  let suggestion = ''
  if (iProposed && cs.meetingSuggestion) {
    const s = cs.meetingSuggestion
    const isVenue = s.venue.venueType !== 'centroid'
    const etas = Object.entries(s.travelTimes)
      .map(([who, mins]) => `<div class="row" style="gap:10px"><span class="who" style="font-size:14px">${esc(who)}</span><span class="pill warn" style="margin-left:auto">${Math.round(mins)} min</span></div>`)
      .join('')
    // A real venue names itself ("The Coach & Horses"); a bare centroid is a fair road-point.
    const heading = isVenue
      ? `📍 <strong>${esc(s.venue.name)}</strong> — a fair spot everyone can reach:`
      : '📍 A fair spot for everyone (as-the-crow-flies):'
    // Only worth offering when there's more than one candidate venue to balance between.
    const fairness = cs.meetingVenues.length >= 2
      ? `<div class="note" style="margin-top:8px">Balance travel</div>
         <div class="row" style="gap:8px;flex-wrap:wrap">${FAIRNESS_OPTIONS
        .map(([f, label]) => `<button class="btn small${meetingFairness === f ? ' primary' : ''}" data-action="mtg-fairness" data-fair="${f}">${label}</button>`)
        .join('')}</div>`
      : ''
    suggestion = `<div class="note" style="margin-top:6px">${heading}</div>
      <div class="list">${etas}</div>
      ${fairness}
      <button class="btn small primary" data-action="set-meeting-rzv">Set this as the meeting point</button>`
  } else if (iProposed) {
    suggestion = `<div class="note">Waiting for a second spot to work out a fair place…</div>`
  }

  return `<div class="section-title" style="margin-top:22px">Meeting point</div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between"><strong>Finding where to meet</strong><span class="muted">${count} sharing</span></div>
      ${prompt}
      ${suggestion}
      ${iProposed ? '<button class="btn small ghost" data-action="cancel-meeting">Cancel</button>' : ''}
    </div>`
}

function rzvCard(): string {
  const me = persisted.identity?.pk
  const cs = active()
  if (cs?.rendezvous) {
    const r = cs.rendezvous
    const dueIn = r.deadline - nowSec()
    const at = new Date(r.deadline * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const rows = members().map((pk) => {
      const st = cs.rzvStatuses.get(pk)
      const isMe = pk === me
      const pill = !st ? '<span class="pill">no signal</span>'
        : st.status === 'arrived' ? '<span class="pill active">arrived</span>'
          : st.status === 'at-risk' ? '<span class="pill alert">at risk</span>'
            : `<span class="pill warn">${fmtMins(st.etaSeconds)} away</span>`
      return `<div class="row" style="gap:10px">${avatarHtml(pk, isMe, true)}<span class="who" style="font-size:14px">${isMe ? 'You' : esc(nameFor(pk))}</span><span style="margin-left:auto">${pill}</span></div>`
    }).join('')
    const modes = (['walk', 'cycle', 'drive', 'transit'] as const)
      .map((m) => `<button class="btn small${travelMode === m ? ' primary' : ''}" data-action="rzv-mode" data-mode="${m}">${m}</button>`).join('')
    return `<div class="section-title" style="margin-top:22px">Meeting point</div>
      <div class="card stack">
        <div class="row" style="justify-content:space-between"><strong>${r.mode === 'be-back' ? 'Be back' : 'Meet'} <span id="rzv-countdown" class="rzv-countdown${dueIn <= 0 ? ' overdue' : ''}">${countdownLabel(dueIn)}</span></strong><span class="muted">by ${at}</span></div>
        <div class="note" style="margin-top:-2px">📍 ${esc(r.place.label || r.place.address || 'a set spot')}</div>
        <button class="btn small ghost" data-action="copy-rzv">Copy address for a taxi</button>
        <div class="list">${rows}</div>
        <div class="note">How you're getting there</div>
        <div class="chip-row">${modes}</div>
        ${r.setBy === me ? '<button class="btn small ghost" data-action="clear-rzv">Clear meeting point</button>' : ''}
      </div>`
  }
  // While a meeting-point search is live, the meeting card stands in for the setup.
  if (cs?.meeting) return ''
  return `<div class="section-title" style="margin-top:22px">Meeting point</div>
    <div class="card stack">
      <div class="field"><input class="input" id="rzv-place" placeholder="The Crown, or an address — blank for here" autocapitalize="words" autocorrect="off" /></div>
      <div class="note">A place or address (taxi-friendly), or leave blank to use your spot. ETAs are as-the-crow-flies.</div>
      <div class="chip-row">
        <button class="btn small${rzvDurationMin === 30 ? ' primary' : ''}" data-action="rzv-dur" data-min="30">30 min</button>
        <button class="btn small${rzvDurationMin === 60 ? ' primary' : ''}" data-action="rzv-dur" data-min="60">1 hour</button>
        <button class="btn small${rzvDurationMin === 120 ? ' primary' : ''}" data-action="rzv-dur" data-min="120">2 hours</button>
      </div>
      <div class="row" style="gap:10px">
        <button class="btn small primary" data-action="set-rzv">Set meeting point</button>
        <button class="btn small ghost" data-action="rzv-pick">📍 Pick on map</button>
      </div>
      <div class="note" style="margin-top:2px">Not sure where? Everyone shares a rough spot and flock picks a fair place.</div>
      <button class="btn small ghost" data-action="propose-meeting">🧭 Find a meeting point</button>
    </div>`
}

function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'tab': tab = (node.dataset.tab as typeof tab); render(); break
    case 'switch-circle': switchCircle(node.dataset.id as string); break
    case 'add-circle': adding = true; onboardStep = 'intro'; render(); break
    case 'go-invite': tab = 'circle'; render(); break
    case 'mode': setMode(node.dataset.mode as Mode); break
    case 'toggle-share': {
      const covert = sharing && wasCovertHold('toggle-share') // only stopping can be coerced
      sharing ? stopSharing() : startSharing()
      if (covert) void raiseCovertSelfAlarm()
      break
    }
    case 'pickup': void emit('pickup'); break
    case 'sos-retry': void emit('help'); break
    case 'geo-retry': geoIssue = null; sharing = false; startSharing(); break
    case 'im-safe': { const covert = wasCovertHold('im-safe'); void standDown(covert); break }
    case 'see-alert': goToAlert(); break
    case 'pickup-show': pickupPanel = 'show'; showDuressWord = false; pickupOutcome = null; render(); break
    case 'pickup-check': pickupPanel = 'check'; pickupOutcome = null; render(); break
    case 'pickup-close': pickupPanel = null; pickupOutcome = null; showDuressWord = false; render(); break
    case 'pickup-check-run': void runSpokenCheck(); break
    case 'copy-invite': copyInvite(); break
    case 'copy-npub': copyNpub(); break
    case 'send-invite': void sendInvite(); break
    case 'reseed': void reseedCircle(); break
    case 'ask-remove': removeConfirmPk = node.dataset.pk ?? null; render(); break
    case 'cancel-remove': removeConfirmPk = null; render(); break
    case 'ack-new-members': patchActive({ unseenMembers: [] }); render(); break
    case 'dismiss-hint':
      persisted.hints = store.withHintDismissed(persisted.hints, node.dataset.hint ?? '')
      store.save(persisted); render(); break
    case 'toggle-hints': {
      const h = persisted.hints ?? { on: true, dismissed: [] }
      persisted.hints = { ...h, on: !h.on }
      store.save(persisted); render(); break
    }
    case 'toggle-advanced': showAdvanced = !showAdvanced; render(); break
    case 'reset-hints':
      persisted.hints = { on: true, dismissed: [] }
      store.save(persisted); toast('Tips are back on'); render(); break
    case 'remove-member': removeConfirmPk = null; void reseedCircle(node.dataset.pk); break
    case 'checkin': void sendCheckIn(); break
    case 'buzz': void sendBuzz(node.dataset.reason ?? (document.getElementById('buzz-custom') as HTMLInputElement | null)?.value ?? ''); break
    case 'dismiss-buzz': activeBuzz = null; render(); break
    case 'set-rzv': void setRendezvous(); break
    case 'clear-rzv': clearRendezvous(); break
    case 'rzv-dur': rzvDurationMin = Number(node.dataset.min); render(); break
    case 'rzv-mode': travelMode = node.dataset.mode as TravelMode; render(); break
    case 'copy-rzv': copyRzvForTaxi(); break
    case 'rzv-pick': pickRzvOnMap(); break
    case 'rzv-pick-set': void setRzvFromMap(); break
    case 'rzv-pick-cancel': cancelRzvPick(); break
    case 'propose-meeting': void proposeMeeting(); break
    case 'share-meeting': void contributeMeetingShare(); break
    case 'share-meeting-exact': void contributeMeetingShare(true); break
    case 'dismiss-meeting': dismissMeeting(); break
    case 'set-meeting-rzv': void setMeetingAsRendezvous(); break
    case 'mtg-fairness': setMeetingFairness(node.dataset.fair as FairnessStrategy); break
    case 'cancel-meeting': cancelMeeting(); break
    case 'ask-dark': goingDark = true; render(); break
    case 'cancel-dark': goingDark = false; render(); break
    case 'dark-dur': {
      darkDurSec = Number(node.dataset.sec)
      root.querySelectorAll<HTMLElement>('[data-action="dark-dur"]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.sec) === darkDurSec))
      const cust = document.getElementById('dark-custom')
      if (cust) (cust as HTMLElement).hidden = darkDurSec !== -1
      break
    }
    case 'do-dark': {
      const covert = wasCovertHold('do-dark')
      goDark()
      if (covert) void raiseCovertSelfAlarm()
      break
    }
    case 'come-back': comeBack(); break
    case 'edit-petname': editingPetname = node.dataset.pk ?? null; render(); break
    case 'save-petname': savePetname(node.dataset.pk as string); break
    case 'cancel-petname': editingPetname = null; render(); break
    case 'toggle-profiles': toggleProfiles(); break
    case 'arm-menu': armingCheckin = true; render(); break
    case 'cancel-arm': armingCheckin = false; render(); break
    case 'arm': armCheckin(Number(node.dataset.interval)); break
    case 'disarm-checkin': {
      const covert = wasCovertHold('disarm-checkin')
      disarmCheckin()
      if (covert) void raiseCovertSelfAlarm()
      break
    }
    case 'save-relay': saveRelay(); break
    case 'leave': leave(); break
    case 'ask-disband': disbandConfirm = true; render(); break
    case 'cancel-disband': disbandConfirm = false; render(); break
    case 'disband': void disbandCircle(); break
    case 'ask-reset': resetConfirm = true; render(); break
    case 'cancel-reset': resetConfirm = false; render(); break
    case 'reset-device': resetDevice(); break
    case 'backup-copy': void doBackup('copy'); break
    case 'backup-download': void doBackup('download'); break
    case 'add-zone': addMode = true; addZoneKind = (node.dataset.kind as 'safe' | 'noreport') ?? 'safe'; newZonePolicy = 'withhold'; renderMapPanel(); updatePreview(); break
    case 'zone-kind': addZoneKind = node.dataset.kind as 'safe' | 'noreport'; renderMapPanel(); updatePreview(); break
    case 'zone-policy': newZonePolicy = node.dataset.policy as 'withhold' | 'coarse'; renderMapPanel(); updatePreview(); break
    case 'cancel-zone': addMode = false; addZoneKind = 'safe'; mapView?.setPreview(null); renderMapPanel(); break
    case 'save-zone': saveZone(); break
    case 'del-zone': delZone(Number(node.dataset.i)); break
    case 'del-noreport': delNoReport(Number(node.dataset.i)); break
    case 'save-offline-map': void saveOfflineMap(); break
    case 'remove-offline-map': void removeOfflineMap(); break
    case 'map-labels': void setMapLabels(node.dataset.mode as MapLabelMode); break
    default: break
  }
}

function wireSos(node: HTMLElement): void {
  const fill = node.querySelector('.fill') as HTMLElement | null
  const DURATION = 1400
  let raf = 0
  let start = 0
  const reset = (): void => {
    cancelAnimationFrame(raf)
    raf = 0
    start = 0
    node.dataset.armed = 'false'
    fill?.style.setProperty('--p', '0')
  }
  const step = (ts: number): void => {
    if (!start) start = ts
    const p = Math.min(1, (ts - start) / DURATION)
    fill?.style.setProperty('--p', String(p))
    if (p >= 1) { reset(); void emit('help'); return }
    raf = requestAnimationFrame(step)
  }
  const begin = (e: Event): void => { e.preventDefault(); node.dataset.armed = 'true'; start = 0; raf = requestAnimationFrame(step) }
  node.addEventListener('pointerdown', begin)
  node.addEventListener('pointerup', reset)
  node.addEventListener('pointerleave', reset)
  node.addEventListener('pointercancel', reset)
}

// ── Actions ──────────────────────────────────────────────────────────────────
function doCreate(): void {
  const name = (document.getElementById('cname') as HTMLInputElement | null)?.value ?? ''
  persisted.identity ??= store.createIdentity()
  persisted.circleRootHex ??= store.newSeed()
  let expiresAt: number | undefined
  if (ttlMode === 'today') {
    expiresAt = nowSec() + todayWindowSec()
  } else if (ttlMode === 'custom') {
    const n = Number((document.getElementById('ttl-num') as HTMLInputElement | null)?.value) || 0
    const unit = (document.getElementById('ttl-unit') as HTMLSelectElement | null)?.value
    const sec = unit === 'hours' ? n * 3600 : n * 86_400
    expiresAt = sec > 0 ? nowSec() + sec : undefined
  }
  upsertCircle(store.createCircle(name, onboardMode, persisted.identity.pk, persisted.circleRootHex, expiresAt), true)
  onboardStep = 'intro'
  awaitingInvite = false
  adding = false
  ttlMode = 'ongoing'
  tab = 'circle' // land where inviting people is front-and-centre
  render()
}

/** Remote join: create an identity, show my npub, and wait for a gift-wrapped invite. */
function doJoinRemote(): void {
  persisted.identity ??= store.createIdentity()
  store.save(persisted)
  awaitingInvite = true
  awaitSince = Date.now()
  onboardStep = 'await'
  render()
  // Re-render once the "still waiting" guidance becomes due — no dead-end spinner.
  window.setTimeout(() => { if (onboardStep === 'await') render() }, AWAIT_GUIDE_MS + 500)
}

function doJoin(): void {
  const code = (document.getElementById('jcode') as HTMLTextAreaElement | null)?.value ?? ''
  try {
    const circle = store.decodeInvite(store.inviteCodeFrom(code))
    persisted.identity ??= store.createIdentity()
    if (persisted.circles.some((c) => c.id === circle.id)) { switchCircle(circle.id); adding = false; return }
    circle.members = [persisted.identity.pk]
    circle.joinedAt = nowSec() // the roster about to replay is not news — see JOIN_GRACE_SEC
    upsertCircle(circle, true)
    onboardStep = 'intro'
    adding = false
    tab = 'home'
    render()
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Invalid invite code.')
  }
}

function setMode(mode: Mode): void {
  if (!activeCircle()) return
  patchActive({ mode })
  breachActive = false
  syncWatch() // Private↔Share-live changes the accuracy tier
  render()
}

// The location watch should run only when it can actually do something: we're
// sharing, not on a deliberate break, and the app is in the foreground. Anything
// else is GPS burned for nothing — an off-grid break emits nothing, and a hidden
// PWA can't sample reliably regardless. (Minimal-footprint north star — Phase H.)
function shouldSample(): boolean {
  return sharing && !isDark() && !hidden
}

// A night-out share is coarse (geohash-6, ~600 m), so low-power network/cell
// location is ample — and coarser hardware is a privacy win too. Family breach
// detection needs GPS. (Minimal-footprint north star — Phase H.)
function desiredHighAccuracy(): boolean {
  return activeCircle()?.mode !== 'nightout'
}
let watchHighAccuracy = true // accuracy tier the running watch was armed at

function resetSampleCadence(): void { lastSampleFix = null; stationaryStreak = 0 }

/** Next night-out poll delay (ms): tight while moving, backing off when stationary. */
function sampleDelayMs(f: svc.Fix): number {
  const prev = lastSampleFix
  const moved = !prev || hasMoved(
    haversineMetres({ lat: prev.lat, lon: prev.lon }, { lat: f.lat, lon: f.lon }),
    prev.accuracy, f.accuracy, SAMPLE_MOVE_FLOOR,
  )
  stationaryStreak = moved ? 0 : stationaryStreak + 1
  lastSampleFix = f
  return nextPollDelaySeconds(stationaryStreak, SAMPLE_POLL_BOUNDS) * 1000
}

/** Start or stop location sampling to match shouldSample(), re-arming if the tier
 *  changed (e.g. switching to a night-out circle). Family runs a continuous, tight
 *  watch — a breach must be caught fast even for a fast exit, so it never backs off.
 *  Night-out runs an adaptive poll that eases off when stationary (battery). The
 *  single place sampling is turned on or off. */
function syncWatch(): void {
  const want = shouldSample()
  const hi = desiredHighAccuracy()
  if (want && (!stopWatch || hi !== watchHighAccuracy)) {
    stopWatch?.()
    watchHighAccuracy = hi
    resetSampleCadence()
    const onErr = (msg: string, kind: svc.GeoErrorKind): void => {
      if (kind === 'denied') {
        // The one failure the user must fix by hand: keep the toggle honest
        // (sharing reverts) and explain HOW on a persistent card, not a toast.
        geoIssue = 'denied'
        sharing = false
        syncWatch()
      } else if (kind === 'unsupported') {
        toast(msg)
        sharing = false
        syncWatch()
      } else {
        geoIssue = 'nofix' // transient — the watch keeps trying; clears on the next fix
      }
      render()
    }
    stopWatch = hi
      ? svc.watchLocation(onFix, onErr, { highAccuracy: true })
      : svc.pollLocation(onFix, onErr, { highAccuracy: false, nextDelayMs: sampleDelayMs })
  } else if (!want && stopWatch) {
    stopWatch()
    stopWatch = null
  }
}

function startSharing(): void {
  if (sharing) return
  sharing = true
  syncWatch()
  render()
}

function stopSharing(): void {
  sharing = false
  breachActive = false
  geoIssue = null
  syncWatch()
  render()
}

function onFix(f: svc.Fix): void {
  fix = f
  geoIssue = null // any successful fix clears the location-trouble card
  if (isDark()) { refresh(); return } // on a break — emit nothing at all
  broadcastRzvStatus()
  if (sharing) void autoEmit()
  else refresh()
}

// Automatic, movement-driven emission for the active circle: a night-out coarse
// beacon or a family breach disclosure. Unlike emit('pickup'|'help'), it is both
// rate-limited AND movement-gated (see cadence.ts) — an identical geohash cell is
// never re-sent, so standing still doesn't spam relays; only a slow heartbeat
// keeps a stationary member reading as "active". Explicit SOS/pick-up bypass all
// of this and always send.
async function autoEmit(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id || !fix) { refresh(); return }
  let f = fix
  // Family: if a cheap (low-power) fix can't tell which side of a safe-zone edge
  // we're on, take one sharp GPS fix before deciding — so we neither miss a breach
  // nor cry wolf on one. Only escalates near an edge, so it stays cheap elsewhere.
  if (c.mode === 'family' && (c.geofences?.length ?? 0) > 0
      && classifyContainment({ lat: f.lat, lon: f.lon }, f.accuracy, c.geofences ?? []) === 'uncertain') {
    const sharp = await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 0, timeoutMs: 4000 })
    if (sharp) { f = sharp; fix = sharp }
  }
  const plan = decideEmission({
    mode: c.mode,
    position: { lat: f.lat, lon: f.lon },
    trigger: 'none',
    geofences: c.mode === 'family' ? c.geofences ?? [] : undefined,
    offGrid: isDark(),
    noReportZones: persisted.noReportZones,
    accuracyMetres: f.accuracy,
  })
  breachActive = plan.reason === 'breach'
  const type = signalTypeForReason(plan.reason)
  // Automatic path never carries 'help' (that's an explicit trigger); the guard
  // also narrows `type` to a LocationSignalType for buildLocationSignal.
  if (!type || type === 'help' || plan.action === 'withhold') { refresh(); return }
  const geohash = encode(f.lat, f.lon, plan.precision)
  const breach = plan.reason === 'breach'
  const prev = beaconCadence.get(c.id) ?? { lastGeohash: null, lastSentAt: 0 }
  if (!shouldEmitBeacon(geohash, prev, nowSec(), {
    minIntervalSeconds: breach ? BREACH_MIN_INTERVAL : COARSE_MIN_INTERVAL,
    heartbeatSeconds: breach ? BREACH_HEARTBEAT : COARSE_HEARTBEAT,
  })) { refresh(); return }
  try {
    const template = await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: type, geohash, precision: plan.precision })
    await publishSignal(template, c)
    // Only record the send (local pin + cadence) once a relay has accepted it, so a
    // transient failure is retried on the next fix rather than silently swallowed.
    saveBeacon(c.id, { member: id.pk, geohash, precision: plan.precision, timestamp: nowSec() })
    beaconCadence.set(c.id, { lastGeohash: geohash, lastSentAt: nowSec() })
  } catch { /* no relay accepted — leave cadence untouched so the next fix retries */ }
  refresh()
}

async function emit(trigger: 'pickup' | 'help'): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  // Freshest possible location for an explicit trigger: a one-shot GPS fix on a
  // short deadline (~2.5 s), falling back to the last watched fix so an alert is
  // never delayed. Decouples emergency accuracy from the ambient watch (which may be
  // suspended on a break, or low-power for a night-out circle). (Phase H.)
  const fresh = await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 5000, timeoutMs: 2500 })
  if (fresh) fix = fresh
  const use = fresh ?? fix
  const position = use ? { lat: use.lat, lon: use.lon } : null
  const plan = decideEmission({
    mode: c.mode,
    position,
    trigger,
    geofences: c.mode === 'family' ? c.geofences ?? [] : undefined,
    offGrid: isDark(),
    noReportZones: persisted.noReportZones,
    accuracyMetres: use?.accuracy,
  })
  const type = signalTypeForReason(plan.reason)
  if (!type) {
    if (trigger === 'pickup') toast('Need your location first — start sharing.')
    return
  }
  try {
    let template
    if (type === 'help') {
      // A no-report zone can cap even an SOS — send help without coordinates, or coarse.
      const location = position && plan.action !== 'withhold'
        ? { geohash: encode(position.lat, position.lon, plan.precision), precision: plan.precision, locationSource: 'beacon' as const }
        : null
      template = await buildHelpSignal({ groupId: c.id, seedHex: c.seedHex, member: id.pk, location })
    } else {
      if (plan.action === 'withhold' || !position) {
        if (trigger === 'pickup') toast('Need your location first — start sharing.')
        return
      }
      const geohash = encode(position.lat, position.lon, plan.precision)
      template = await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: type, geohash, precision: plan.precision })
      saveBeacon(c.id, { member: id.pk, geohash, precision: plan.precision, timestamp: nowSec() })
    }
    await publishSignal(template, c)
    // "Help sent" only AFTER a confirmed publish — the orb must never claim an
    // alert went out when it didn't (the most dangerous lie the UI could tell).
    if (type === 'help') { alertActive = true; alertFailed = false; alertCircleId = c.id }
    toast(trigger === 'help' ? 'Help sent to your circle' : 'Pick-up request sent')
  } catch {
    // A failed SOS gets a PERSISTENT retry state on the orb, not a vanishing toast.
    if (type === 'help') alertFailed = true
    else toast("Couldn't send — check your connection.")
  }
  refresh()
}

// ── Spoken pick-up verification ───────────────────────────────────────────────
// Current context for the active circle: the shared seed, the full roster (so every
// member's duress word is checked — never a subset), me, and the time-based counter
// both devices derive from (canary getCounter) — so the two phones agree with no
// round-trip and nothing is ever published for the check itself.
function spokenCtx(): { seedHex: string; members: string[]; me: string; counter: number } | null {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return null
  return { seedHex: c.seedHex, members: c.members ?? [], me: id.pk, counter: spokenCounter(nowSec()) }
}

async function runSpokenCheck(): Promise<void> {
  const ctx = spokenCtx()
  if (!ctx) return
  const input = (document.getElementById('spoken-input') as HTMLInputElement | null)?.value ?? ''
  const res = checkSpokenWord(input, ctx.seedHex, ctx.members, ctx.counter)
  // verified / stale / duress → an identical ✓. The duress case MUST be visually
  // indistinguishable so a coercer watching this screen sees an ordinary success;
  // only a true 'failed' shows the ✗.
  pickupOutcome = res.status === 'failed' ? 'fail' : 'pass'
  render()
  // Then, silently, raise the circle alarm for a coerced collector — after the
  // render so nothing about the alarm can surface on this device.
  if (res.status === 'duress' && res.duressMembers.length) await raiseDuressAlarm(res.duressMembers)
}

// ── Covert duress on coercion-point actions (FLOCK.md §6.1) ──────────────────
// "Stop sharing", "turn off the check-in" and "take a break" are the three actions
// a coercer plausibly forces. A silent long-press performs the IDENTICAL visible
// action — nothing on this screen differs from a normal tap — and additionally
// raises the circle help alarm about ME, which only the OTHER members ever see.
const COVERT_HOLD_MS = 1200

// Keyed by action name, not node — a background re-render mid-hold swaps the
// button element, and the covert intent must survive it.
const covertHold: Record<string, number> = {}
function beginHold(action: string): void { covertHold[action] = Date.now() }

/** True when the click that just fired came from a deliberate long hold. The
 *  10 s ceiling discards stale pointerdowns (e.g. a drag-away that never
 *  clicked), so a later keyboard activation can't misread as covert. */
function wasCovertHold(action: string): boolean {
  const t = covertHold[action]
  delete covertHold[action]
  return !!t && Date.now() - t >= COVERT_HOLD_MS && Date.now() - t < 10_000
}

/** Coerced stop/disarm/off-grid: the visible action has already happened,
 *  identically to a normal tap. Raise the silent circle alarm about ME —
 *  `covertHelpUntil` keeps my own relay echo from ever surfacing here. */
async function raiseCovertSelfAlarm(): Promise<void> {
  const id = persisted.identity
  if (!id) return
  covertHelpUntil = nowSec() + 120
  await raiseDuressAlarm([id.pk])
}

// Silently raise the circle's help alarm for a coerced collector spotted during a
// pick-up check. No toast, no local alert state — a coercer may be watching THIS
// phone; only the other members' devices light up (see the onIncoming help guard).
// Location follows the same policy as an SOS, so a no-report refuge is never pinned.
async function raiseDuressAlarm(members: string[]): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const use = (await svc.currentPosition({ enableHighAccuracy: true, maximumAge: 5000, timeoutMs: 2500 })) ?? fix
  const position = use ? { lat: use.lat, lon: use.lon } : null
  const plan = decideEmission({
    mode: c.mode,
    position,
    trigger: 'help',
    geofences: c.mode === 'family' ? c.geofences ?? [] : undefined,
    offGrid: isDark(),
    noReportZones: persisted.noReportZones,
    accuracyMetres: use?.accuracy,
  })
  const location = position && plan.action !== 'withhold'
    ? { geohash: encode(position.lat, position.lon, plan.precision), precision: plan.precision, locationSource: 'beacon' as const }
    : null
  for (const m of members) {
    try {
      const template = await buildHelpSignal({ groupId: c.id, seedHex: c.seedHex, member: m, location })
      await publishSignal(template, c)
    } catch { /* stay silent even on failure — no tell on this device */ }
  }
}

// "I'm safe now" — stand down my help alert for the whole circle. A covert
// long-press sends a COERCED all-clear instead: this screen behaves identically
// (a watching coercer sees a normal stand-down, same toast, same calm orb) but
// receivers ignore it, so the circle stays alarmed (FLOCK §6.1).
async function standDown(coerced: boolean): Promise<void> {
  const id = persisted.identity
  const c = persisted.circles.find((x) => x.id === alertCircleId) ?? activeCircle()
  if (!id || !c) return
  try {
    const tmpl = await buildAllClearSignal({ groupId: c.id, seedHex: c.seedHex, member: id.pk, ...(coerced ? { coerced: true } : {}) })
    await publishSignal(tmpl, c)
    alertActive = false
    alertFailed = false
    alertCircleId = null
    cstate(c.id).alerts.delete(id.pk)
    toast("Stand-down sent — your circle knows you're OK")
    render()
  } catch { toast("Couldn't send — check your connection and try again") }
}

// The orb said "[Name] needs help — tap to see where": focus that circle, on the
// map if we already hold a location for them, otherwise on the roster. Deliberately
// NOT switchCircle(), which would clear my own live alert flags.
function goToAlert(): void {
  const inc = incomingAlert()
  if (!inc) return
  persisted.activeCircleId = inc.circleId
  store.save(persisted)
  syncWatch()
  tab = cstate(inc.circleId).beacons.has(inc.who) ? 'map' : 'circle'
  render()
}

// Silent long-press to reveal the duress word on the "prove it's me" tile. No fill
// or animation (that would be a tell) — hold ~0.6 s and the word swaps in place.
function wireDuressReveal(node: HTMLElement): void {
  const HOLD = 600
  let timer = 0
  const begin = (e: Event): void => { e.preventDefault(); timer = window.setTimeout(() => { showDuressWord = !showDuressWord; render() }, HOLD) }
  const cancel = (): void => { if (timer) { clearTimeout(timer); timer = 0 } }
  node.addEventListener('pointerdown', begin)
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointerleave', cancel)
  node.addEventListener('pointercancel', cancel)
}

function copyInvite(): void {
  const c = activeCircle()
  if (!c) return
  const link = store.inviteLink(c, location.origin)
  navigator.clipboard?.writeText(link).then(
    () => toast('Invite link copied — send it only through a chat you trust'),
    () => { showInviteLinkText = true; render(); toast("Couldn't copy — here's the link to select") },
  )
}

function copyNpub(): void {
  const id = persisted.identity
  if (!id) return
  let npub = id.pk
  try { npub = npubEncode(id.pk) } catch { /* keep hex */ }
  navigator.clipboard?.writeText(npub).then(() => toast('Invite key copied'), () => toast('Copy failed'))
}

// ── Profiles & petnames ───────────────────────────────────────────────────────
function savePetname(pk: string): void {
  const v = (document.getElementById(`pet-${pk}`) as HTMLInputElement | null)?.value?.trim() ?? ''
  if (v) persisted.petnames = { ...persisted.petnames, [pk]: v }
  else { const next = { ...persisted.petnames }; delete next[pk]; persisted.petnames = next }
  store.save(persisted)
  editingPetname = null
  toast(v ? 'Nickname saved' : 'Nickname cleared')
  render()
}

function toggleProfiles(): void {
  persisted.showProfiles = !persisted.showProfiles
  store.save(persisted)
  if (persisted.showProfiles) ensureProfiles()
  toast(persisted.showProfiles ? 'Showing public names & photos' : 'Public profiles off')
  render()
}

/** When opted-in, fetch public kind:0 profiles for everyone across our circles. */
function ensureProfiles(): void {
  if (!persisted.showProfiles) return
  const pks = new Set<string>()
  for (const c of persisted.circles) for (const pk of c.members ?? []) pks.add(pk)
  fetchProfiles([...pks], () => { if (!isEditing()) refresh() })
}

function saveRelay(): void {
  const el = document.getElementById('relay') as HTMLTextAreaElement | HTMLInputElement | null
  const relays = parseRelayList(el?.value ?? '')
  if (!relays.length) { toast('Enter at least one ws:// or wss:// relay'); return }
  persisted.relayUrls = relays
  store.save(persisted)
  ensureInviteSub()
  ensureSubscriptions()
  toast(relays.length > 1 ? `Saved ${relays.length} relays` : 'Relay saved')
}

/** Leave just the active circle (local removal). Identity and other circles stay. */
function leave(): void {
  const c = activeCircle()
  if (!c) return
  removeCircle(c.id)
  breachActive = false
  alertActive = false
  alertFailed = false
  alertCircleId = null
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  tab = 'home'
  toast(`Left ${c.name}`)
  render()
}

/** Disband the active circle for *everyone* — broadcast a tombstone, then wipe locally. */
async function disbandCircle(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  try {
    await publishSignal(await buildDisbandSignal({ groupId: c.id, seedHex: c.seedHex, by: id.pk }), c)
  } catch { /* still drop locally even if the broadcast fails */ }
  const name = c.name
  removeCircle(c.id)
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  breachActive = false
  alertActive = false
  alertFailed = false
  alertCircleId = null
  tab = 'home'
  toast(`Disbanded ${name}`)
  render()
}

// ── Backup & restore ─────────────────────────────────────────────────────────
const MIN_BACKUP_PASS = 8

/** Export this device's state as a passphrase-encrypted code (copy or file). */
async function doBackup(how: 'copy' | 'download'): Promise<void> {
  const input = document.getElementById('backup-pass') as HTMLInputElement | null
  const pass = input?.value ?? ''
  if (pass.length < MIN_BACKUP_PASS) { toast(`Pick a passphrase of at least ${MIN_BACKUP_PASS} characters`); return }
  try {
    const blob = await exportBackup(persisted, pass)
    if (how === 'copy') {
      await navigator.clipboard.writeText(blob)
      toast('Backup code copied — store it somewhere safe')
    } else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([blob], { type: 'text/plain' }))
      a.download = `flock-backup-${new Date().toISOString().slice(0, 10)}.txt`
      a.click()
      URL.revokeObjectURL(a.href)
      toast('Backup file saved — store it somewhere safe')
    }
    if (input) input.value = ''
  } catch { toast("Couldn't create the backup") }
}

/** Restore a backup from the welcome screen, then boot cleanly from the new state. */
async function doRestore(): Promise<void> {
  const code = (document.getElementById('restore-code') as HTMLTextAreaElement | null)?.value ?? ''
  const pass = (document.getElementById('restore-pass') as HTMLInputElement | null)?.value ?? ''
  if (!code.trim() || !pass) { toast('Paste the backup code and its passphrase'); return }
  try {
    const data = await importBackup(code, pass)
    persisted = applyBackup(persisted, data)
    store.save(persisted)
    location.reload() // boot from the restored state — subs, monitor and map come up as normal
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Restore failed')
  }
}

/** Full reset: sign out, wipe local state and every circle on this device. */
function resetDevice(): void {
  if (persisted.authMethod === 'signet') { try { void signetLogout() } catch { /* ignore */ } }
  signetSigner = null
  store.reset()
  stopWatch?.(); stopWatch = null
  stopAllSubs()
  stopInviteSub?.(); stopInviteSub = null
  inviteSubKey = ''
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = 0 }
  if (rzvTicker) { clearInterval(rzvTicker); rzvTicker = 0 }
  sharing = false
  alertActive = false
  alertFailed = false
  alertCircleId = null
  breachActive = false
  checkinAlert = false
  awaitingInvite = false
  armingCheckin = false
  adding = false
  addMode = false
  disbandConfirm = false
  resetConfirm = false
  removeConfirmPk = null
  mapView?.destroy()
  mapView = null
  fix = null
  circleStates.clear()
  meetingDismissed.clear()
  beaconCadence.clear()
  persisted = store.load()
  onboardStep = 'intro'
  tab = 'home'
  render()
}

// ── Inbound ──────────────────────────────────────────────────────────────────
function ensureSubscriptions(): void {
  const relays = persisted.relayUrls
  const relayKey = relays.join(',')
  // Desired subs: one per circle, keyed by inbox (a reseed → new inbox → re-subscribe).
  const wanted = new Map<string, store.Circle>()
  for (const c of persisted.circles) {
    const inbox = deriveInbox(c.seedHex)
    wanted.set(`${c.id}@${relayKey}@${inbox.pk}`, c)
  }
  for (const [key, stop] of subs) if (!wanted.has(key)) { stop(); subs.delete(key) }
  for (const [key, c] of wanted) {
    if (subs.has(key)) continue
    const inbox = deriveInbox(c.seedHex)
    const circleId = c.id
    subs.set(key, svc.subscribeGiftWraps(relays, inbox.pk, (wrap) => { void onSignalWrap(circleId, wrap, inbox.sk) }))
  }
}

function stopAllSubs(): void {
  for (const stop of subs.values()) stop()
  subs.clear()
}

async function onSignalWrap(circleId: string, wrap: { pubkey: string; content: string }, inboxSk: Uint8Array): Promise<void> {
  const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), wrap)
  if (rumor) await onIncoming(circleId, rumor)
}

async function onIncoming(circleId: string, e: { pubkey: string; content: string; tags: string[][]; created_at: number }): Promise<void> {
  const c = persisted.circles.find((x) => x.id === circleId)
  const me = persisted.identity
  if (!c) return
  const st = cstate(c.id)
  const t = e.tags.find((x) => x[0] === 't')?.[1]
  try {
    if (t === 'help') {
      const a = await decryptDuressAlert(deriveDuressKey(c.seedHex), e.content)
      const who = a.member || e.pubkey
      // Spoken-verify silent duress: an alert whose SUBJECT differs from its SENDER is
      // only ever produced by a pick-up check (a normal SOS always names its own
      // sender). If I'm either party — the flagged collector, or the child who
      // detected it — it must NEVER surface on THIS screen; a coercer may be watching.
      // Other members surface and act on it as usual.
      if (me && who !== e.pubkey && (who === me.pk || e.pubkey === me.pk)) return
      // A covert SELF-alarm (coerced stop / disarm / off-grid) names its own sender.
      // Its echo must never surface on the device that raised it — a coercer may be
      // holding it. Every other device alerts as usual. An overt SOS (no covert
      // window) keeps showing on its own sender's screen, as it always did.
      if (me && who === me.pk && e.pubkey === me.pk && nowSec() < covertHelpUntil) return
      st.alerts.set(who, e.created_at)
      // Receiver state derives from st.alerts (see incomingAlert) — alertActive is
      // the SENDER's "my alert went out" flag and must never be set on receive.
      if (!me || e.pubkey !== me.pk) toast(`🚨 Help raised in ${c.name}`)
      if (a.geohash) saveBeacon(c.id, { member: who, geohash: a.geohash, precision: a.precision, timestamp: a.timestamp || e.created_at })
    } else if (t === 'beacon' || t === 'breach' || t === 'pickup') {
      const p = await decryptBeacon(deriveBeaconKey(c.seedHex), e.content)
      saveBeacon(c.id, { member: e.pubkey, geohash: p.geohash, precision: p.precision, timestamp: p.timestamp || e.created_at })
      if (t === 'pickup' && (!me || e.pubkey !== me.pk)) toast(`Pick-up request in ${c.name}`)
    } else if (t === ALLCLEAR_SIGNAL_TYPE) {
      const ac = await decryptAllClear(c.seedHex, e.content)
      // Only the alert's OWNER can stand it down — a member must not be able to
      // clear someone else's alarm (e.g. a flagged collector clearing a duress flag).
      if (ac.member !== e.pubkey) return
      // A coerced stand-down (flag inside the encryption) is ignored: the sender's
      // screen already shows a normal stand-down, but the circle stays alarmed.
      if (ac.coerced) return
      st.alerts.delete(ac.member)
      if (me && ac.member === me.pk) { alertActive = false; alertFailed = false }
      else toast(`${nameFor(ac.member)} is safe — alert stood down`)
    } else if (t === CHECKIN_SIGNAL_TYPE) {
      const ci = await decryptCheckIn(c.seedHex, e.content)
      st.checkins.set(ci.member, ci)
      evaluateCheckinAlarm()
    } else if (t === 'buzz') {
      const bz = await decryptBuzz(c.seedHex, e.content)
      if (!me || bz.from !== me.pk) {
        const mine = !!me && bz.target === me.pk
        activeBuzz = { from: bz.from, reason: bz.reason, mine, circle: c.name }
        try { navigator.vibrate?.(mine ? [300, 120, 300, 120, 300] : [200, 100, 200]) } catch { /* no haptics */ }
      }
    } else if (t === RENDEZVOUS_SIGNAL_TYPE) {
      st.rendezvous = await decryptRendezvous(c.seedHex, e.content)
      st.rzvStatuses.clear()
      st.meeting = null; st.meetingShares.clear(); st.meetingSuggestion = null // a set rendezvous supersedes any in-flight search
    } else if (t === RENDEZVOUS_STATUS_TYPE) {
      const status = await decryptRendezvousStatus(c.seedHex, e.content)
      st.rzvStatuses.set(status.member, status)
      if (status.status === 'at-risk' && st.rendezvous?.setBy === me?.pk && status.member !== me?.pk) {
        toast(`⚠ ${nameFor(status.member)} may miss the meeting point`)
      }
    } else if (t === MEETING_REQUEST_TYPE) {
      const request = await decryptMeetingRequest(c.seedHex, e.content)
      // A brand-new proposal resets the contributions; an echo of the current one keeps them.
      if (st.meeting?.id !== request.id) {
        st.meeting = request
        st.meetingShares.clear()
        st.meetingSuggestion = null
        if (!me || request.setBy !== me.pk) toast(`${nameFor(request.setBy)} wants to find a place to meet`)
      }
    } else if (t === MEETING_SHARE_TYPE) {
      const share = await decryptMeetingShare(c.seedHex, e.content)
      // Prefer a finer disclosure already held (an exact share via my personal inbox
      // must not be clobbered by this coarser group echo — see mergeMeetingShare).
      if (st.meeting && share.requestId === st.meeting.id && mergeMeetingShare(st, share)) {
        await refreshMeetingSuggestion(c.id) // proposer-only inside; recomputes the fair point
      }
    } else if (t === OFFGRID_SIGNAL_TYPE) {
      const o = await decryptOffGrid(c.seedHex, e.content)
      const prev = st.offgrid.get(o.from)
      const wasDark = !!prev && isOffGrid(prev, nowSec())
      st.offgrid.set(o.from, o)
      const nowDark = isOffGrid(o, nowSec())
      if (!me || o.from !== me.pk) {
        if (nowDark && !wasDark) toast(`${nameFor(o.from)} is taking a break${o.reason ? ` · ${esc(o.reason)}` : ''}`)
        else if (!nowDark && wasDark) toast(`${nameFor(o.from)} is back`)
      }
      evaluateCheckinAlarm() // a planned break clears any false missed-check-in alarm
    } else if (t === FENCES_SIGNAL_TYPE) {
      const fs = await decryptFences(c.seedHex, e.content)
      // Latest-wins against the LIVE circle, not the pre-await snapshot — an edit
      // applied while we were decrypting must not be clobbered by this older set.
      const live = persisted.circles.find((x) => x.id === c.id)
      if (live && isNewerFenceSet(fs, live)) {
        patchCircleById(c.id, { geofences: fs.fences, fencesUpdatedAt: fs.updatedAt, fencesBy: fs.by })
        if (c.id === persisted.activeCircleId) mapView?.setGeofences(fs.fences)
        if (!me || fs.by !== me.pk) toast(`Safe places updated in ${c.name}`)
      }
    } else if (t === DISBAND_SIGNAL_TYPE) {
      const d = await decryptDisband(c.seedHex, e.content)
      const name = c.name
      removeCircle(c.id) // the owner ended it for everyone — drop it and wipe its seed
      if (!activeCircle()) tab = 'home'
      toast(`${d.by === me?.pk ? 'You' : nameFor(d.by)} disbanded ${name}`)
      render()
      return
    } else {
      return
    }
    ensureMember(c, e.pubkey)
    refresh()
  } catch {
    /* not for us, or undecryptable */
  }
}
