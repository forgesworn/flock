// flock PWA — UI controller. Vanilla TS, render-on-state. Wires the flock
// library (decideEmission → build signal) to real Nostr publish/subscribe.

import * as store from './store'
import type { Mode } from './store'
import * as svc from './services'
import { makeLocalSigner, makeSignetSigner, type FlockSigner } from './signer'
import { login as signetLogin, restoreSession as signetRestore, logout as signetLogout } from 'signet-login'
import { PRIVATE_RELAYS } from './relays'
import { deriveCircleSeed, deriveInbox } from './keys'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from './giftwrap'
import { geocode } from './geo'
import { encode, decode } from 'geohash-kit'
import qrcode from 'qrcode-generator'
import { npubEncode } from 'nostr-tools/nip19'
import type { MapView, MapPoint } from './map'
import { buildInviteWrap, buildReseedWraps, readInvite } from './invite'
import {
  decideEmission,
  signalTypeForReason,
  buildLocationSignal,
  buildHelpSignal,
  classifyPresence,
  isWithinAnyFence,
  buildCheckInSignal,
  decryptCheckIn,
  classifyCheckins,
  missedCheckins,
  CHECKIN_SIGNAL_TYPE,
  buildBuzzSignal,
  decryptBuzz,
  DEFAULT_BUZZ_REASONS,
  assessArrival,
  buildRendezvousSignal,
  decryptRendezvous,
  buildRendezvousStatusSignal,
  decryptRendezvousStatus,
  RENDEZVOUS_SIGNAL_TYPE,
  RENDEZVOUS_STATUS_TYPE,
  type Rendezvous,
  type RendezvousStatus,
  type TravelMode,
  deriveBeaconKey,
  decryptBeacon,
  deriveDuressKey,
  decryptDuressAlert,
  type MemberBeacon,
  type CircleGeofence,
  type CheckIn,
} from '@forgesworn/flock'

// ── State ──────────────────────────────────────────────────────────────────
let persisted = store.load()
let tab: 'home' | 'map' | 'circle' | 'you' = 'home'
let fix: svc.Fix | null = null
let sharing = false
let alertActive = false
let breachActive = false
let stopWatch: (() => void) | null = null
const subs = new Map<string, () => void>() // circleId@relay@inboxPk → unsubscribe (one per circle)
let lastSelfBeacon = 0
let root: HTMLElement
let toastTimer = 0

let mapView: MapView | null = null
let addMode = false
let addRadius = 300

let stopInviteSub: (() => void) | null = null
let inviteSubKey = ''
let awaitingInvite = false
let armingCheckin = false
let checkinAlert = false
let monitorTimer = 0
let activeBuzz: { from: string; reason: string; mine: boolean; circle?: string } | null = null
let travelMode: TravelMode = 'walk'
let rzvDurationMin = 60
let lastRzvStatus = 0

let onboardStep: 'intro' | 'create' | 'join' | 'await' = 'intro'
let onboardMode: Mode = 'family'
let adding = false // adding another circle from within the app (not first-run onboarding)
let newCircleTtl = 0 // chosen transient lifetime (sec) for a new circle; 0 = long-lived

// Per-circle live state — signals are circle-scoped, so beacons/alerts/etc. from
// one circle must never bleed into another. Keyed by circle id.
interface CircleState {
  beacons: Map<string, MemberBeacon>
  alerts: Map<string, number>
  checkins: Map<string, CheckIn>
  rzvStatuses: Map<string, RendezvousStatus>
  rendezvous: Rendezvous | null
}
const circleStates = new Map<string, CircleState>()
function cstate(id: string): CircleState {
  let s = circleStates.get(id)
  if (!s) { s = { beacons: new Map(), alerts: new Map(), checkins: new Map(), rzvStatuses: new Map(), rendezvous: null }; circleStates.set(id, s) }
  return s
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
  if (persisted.activeCircleId === id) persisted.activeCircleId = persisted.circles[0]?.id ?? null
  store.save(persisted)
}
/** Drop transient circles whose lifetime has elapsed. Returns true if any were removed. */
function sweepExpired(): boolean {
  const now = nowSec()
  const live = persisted.circles.filter((c) => !c.expiresAt || c.expiresAt > now)
  if (live.length === persisted.circles.length) return false
  for (const c of persisted.circles) if (!live.includes(c)) circleStates.delete(c.id)
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
  tab = 'home'
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

function toast(msg: string): void {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2800)
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
  store.save(persisted) // persist any legacy→multi-circle migration / pruning straight away
  render()
  void restoreSignet()
}

function render(): void {
  if (tab !== 'map' && mapView) { mapView.destroy(); mapView = null; addMode = false }
  if (persisted.identity) ensureInviteSub()
  if (!persisted.identity || !activeCircle() || adding) {
    root.innerHTML = onboardingView()
    wireOnboard()
    return
  }
  ensureMember(activeCircle() as store.Circle, persisted.identity.pk)
  ensureSubscriptions()
  startMonitor()
  const body = tab === 'home' ? homeView() : tab === 'map' ? mapView_screen() : tab === 'circle' ? circleView() : youView()
  root.innerHTML = `${buzzBanner()}<main class="screen fade-in ${tab === 'map' ? 'map-screen' : ''}">${body}</main>${navView()}<div class="toast" id="toast"></div>`
  wireApp()
}

// ── Views: app ───────────────────────────────────────────────────────────────
function topbar(showModeToggle: boolean): string {
  const c = activeCircle() as store.Circle
  const toggle = showModeToggle ? `
    <div class="mode-toggle" role="group" aria-label="Mode">
      <button data-action="mode" data-mode="family" aria-pressed="${c.mode === 'family'}">Family</button>
      <button data-action="mode" data-mode="nightout" aria-pressed="${c.mode === 'nightout'}">Night out</button>
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

function orbState(): { cls: string; label: string; sub: string } {
  const c = activeCircle() as store.Circle
  if (alertActive) return { cls: 'state-alert', label: 'Help sent', sub: 'Your circle has been alerted' }
  if (checkinAlert) return { cls: 'state-alert', label: 'Check-in missed', sub: "Someone hasn't checked in" }
  if (breachActive) return { cls: 'state-alert', label: 'Outside safe zone', sub: 'Location shared with your circle' }
  if (sharing && fix) {
    return c.mode === 'nightout'
      ? { cls: 'state-share', label: 'Sharing', sub: 'Coarse location · night out' }
      : { cls: 'state-safe', label: 'On watch', sub: 'Stays private unless you raise it' }
  }
  if (sharing && !fix) return { cls: 'state-share', label: 'Locating…', sub: 'Getting a GPS fix' }
  return { cls: 'state-safe', label: 'Private', sub: 'Location withheld until you need it' }
}

function homeView(): string {
  const c = activeCircle() as store.Circle
  const s = orbState()
  return `
    ${topbar(true)}
    <div class="orb-wrap ${s.cls}">
      <div class="orb"><div class="orb-inner">
        <div class="orb-state"><span class="orb-dot"></span>${s.label}</div>
        <div class="orb-sub">${esc(s.sub)}</div>
      </div></div>
    </div>
    <div class="actions">
      <button class="btn ${sharing ? 'ghost' : 'primary'}" data-action="toggle-share">
        ${sharing ? 'Stop sharing' : (c.mode === 'nightout' ? 'Start sharing' : 'Start watch')}
      </button>
      <button class="btn warn" data-action="pickup">Pick me up</button>
      <div class="sos" data-action="sos-hold" data-armed="false" role="button" tabindex="0" aria-label="Hold to send help">
        <div class="fill"></div>
        <span class="label">Hold for help</span>
        <span class="hint">Press and hold to send an SOS</span>
      </div>
    </div>
    <div style="margin-top:14px">${checkinCard()}</div>`
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
      <div class="row" style="justify-content:space-between"><strong>Check-in cadence</strong><button class="btn small ghost" data-action="cancel-arm">Cancel</button></div>
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
        <div><strong>Dead-man's-switch</strong><div class="note">${overdue ? 'Overdue — check in now' : `Next check-in in ${fmtMins(dueIn)}`}</div></div>
        <button class="btn small ghost" data-action="disarm-checkin">Turn off</button>
      </div>
      <button class="btn primary" data-action="checkin">I'm OK — check in</button>
    </div>`
  }
  return `<button class="btn ghost" data-action="arm-menu">Set up check-ins · dead-man's-switch</button>`
}

function circleMemberRow(pk: string, mePk: string): string {
  const st = active()
  const isMe = pk === mePk
  const beacon = st?.beacons.get(pk)
  const presence = beacon ? classifyPresence([beacon], nowSec(), { staleAfterSeconds: 600 })[0] : null
  const ci = st?.checkins.get(pk)
  const ciState = ci ? classifyCheckins([ci], nowSec())[0] : null

  let pill: string
  if (st?.alerts.has(pk)) pill = '<span class="pill alert">help</span>'
  else if (ciState?.status === 'missed') pill = '<span class="pill alert">missed</span>'
  else if (ciState?.status === 'overdue') pill = '<span class="pill warn">overdue</span>'
  else if (ciState) pill = '<span class="pill active">checked in</span>'
  else if (presence) pill = presence.status === 'active'
    ? `<span class="pill active">out · ${fmtAgo(presence.ageSeconds)}</span>`
    : `<span class="pill stale">home · ${fmtAgo(presence.ageSeconds)}</span>`
  else pill = '<span class="pill">no activity</span>'

  const sub = beacon ? `~${esc(beacon.geohash)}` : isMe ? 'you' : 'in this circle'
  return `<div class="member">
    <div class="avatar">${isMe ? 'You' : initials(pk)}</div>
    <div class="meta"><div class="who">${isMe ? 'You' : shortNpub(pk)}</div><div class="when">${sub}</div></div>
    ${pill}
  </div>`
}

function circleView(): string {
  const c = activeCircle() as store.Circle
  const me = persisted.identity as store.Identity
  const mem = members()
  const rows = mem.length
    ? mem.map((pk) => circleMemberRow(pk, me.pk)).join('')
    : '<div class="card muted">Just you so far — invite someone below.</div>'
  return `
    ${topbar(false)}
    <h2 style="margin-bottom:14px">${esc(c.name)}</h2>
    <div class="section-title">Members</div>
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

    ${rzvCard()}

    <div class="section-title" style="margin-top:22px">Invite securely (remote)</div>
    <div class="card stack">
      <div class="field"><label for="invite-npub">Their key (npub)</label><input class="input" id="invite-npub" placeholder="npub1…" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <button class="btn small primary" data-action="send-invite">Send encrypted invite</button>
      <div class="note">The seed is gift-wrapped to their key (NIP-59) — safe over any channel. Ask them to open “Join remotely” and share their key.</div>
    </div>

    <div class="section-title" style="margin-top:22px">Invite in person</div>
    <div class="card stack">
      <div class="qr" id="qr"></div>
      <button class="btn small" data-action="copy-invite">Copy invite code</button>
      <div class="note">Strongest: the QR carries the seed, so scanning keeps it off any network. Treat the copied code like a password.</div>
    </div>`
}

function youView(): string {
  const me = persisted.identity as store.Identity
  const c = activeCircle() as store.Circle
  return `
    ${topbar(false)}
    <h2 style="margin-bottom:14px">You &amp; settings</h2>
    <div class="section-title">Identity</div>
    <div class="card stack">
      <div class="kv"><span class="k">Your key</span><span>${shortNpub(me.pk)}</span></div>
      <div class="kv"><span class="k">Signer</span><span>${persisted.authMethod === 'signet' ? 'Signet (key in your signer)' : 'Local key (preview)'}</span></div>
      <button class="btn small ghost" data-action="copy-npub">Copy my key (npub)</button>
      <div class="note">${persisted.authMethod === 'signet'
        ? 'Signed in with Signet — your key lives in your signer and never touches flock.'
        : 'Quick-start key, stored in this browser only — not secure key storage. Sign in with Signet for real use.'}</div>
    </div>
    <div class="section-title" style="margin-top:18px">Relay</div>
    <div class="card stack">
      <div class="field"><label for="relay">Nostr relay</label><input class="input" id="relay" value="${esc(persisted.relayUrl)}" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <button class="btn small" data-action="save-relay">Save relay</button>
    </div>
    <div class="section-title" style="margin-top:18px">Circle security</div>
    <div class="card stack">
      <button class="btn small" data-action="reseed">Rotate circle key (reseed)</button>
      <div class="note">Generates a new seed and sends it encrypted to current members. Do this if an invite code may have leaked.</div>
      ${members().filter((pk) => pk !== me.pk).map((pk) => `<div class="row"><span class="avatar small">${initials(pk)}</span><span class="who" style="font-size:14px">${shortNpub(pk)}</span><button class="btn small ghost" style="margin-left:auto" data-action="remove-member" data-pk="${pk}">Remove</button></div>`).join('') || '<div class="note">No other members yet.</div>'}
    </div>
    <div class="section-title" style="margin-top:18px">This circle</div>
    <div class="card stack">
      <div class="kv"><span class="k">Name</span><span>${esc(c.name)}</span></div>
      <div class="kv"><span class="k">Mode</span><span>${c.mode === 'nightout' ? 'Night out' : 'Family'}</span></div>
      <div class="kv"><span class="k">Lifetime</span><span>${c.expiresAt ? `transient · ends in ${fmtTtl(c.expiresAt)}` : 'long-lived'}</span></div>
      <button class="btn ghost" data-action="leave">Leave this circle</button>
      <div class="note">Leaving removes it from this device only. Your other circles and your key stay put.</div>
    </div>
    <div class="card stack" style="margin-top:14px">
      <button class="btn small ghost" data-action="reset-device">Sign out &amp; reset this device</button>
      <div class="note">Wipes your key and every circle from this browser.</div>
    </div>
    <div class="note" style="margin-top:16px;text-align:center">flock · disclosure-on-event location · built on canary-kit</div>`
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
        <div id="crosshair" class="crosshair" hidden></div>
      </div>
      <div class="map-panel" id="map-panel">${mapPanelInner()}</div>
    </div>`
}

function mapPanelInner(): string {
  if (addMode) {
    return `
      <div class="row" style="justify-content:space-between">
        <strong>New safe zone</strong>
        <span class="muted" id="radius-label">${addRadius} m</span>
      </div>
      <input class="slider" id="radius" type="range" min="100" max="2000" step="50" value="${addRadius}" />
      <div class="note">Pan the map so the crosshair sits at the centre, then save.</div>
      <div class="row" style="gap:10px">
        <button class="btn small primary" data-action="save-zone">Save zone</button>
        <button class="btn small ghost" data-action="cancel-zone">Cancel</button>
      </div>`
  }
  const zones = persisted.geofences
  const list = zones.length
    ? zones.map((z, i) => {
        const r = z.kind === 'circle' ? `${Math.round(z.radiusMetres)} m radius` : `${z.vertices.length}-point area`
        return `<div class="zone-row"><span class="dot-safe"></span><span class="zone-meta">Safe zone ${i + 1}<small>${r}</small></span><button class="zone-del" data-action="del-zone" data-i="${i}" aria-label="Delete">✕</button></div>`
      }).join('')
    : '<div class="note">No safe zones yet. Add one and you\'ll be alerted if a circle member leaves it.</div>'
  return `
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><strong>Safe zones</strong><button class="btn small" data-action="add-zone">＋ Add</button></div>
    <div class="zone-list">${list}</div>`
}

// ── Views: onboarding ────────────────────────────────────────────────────────
function onboardingView(): string {
  let inner: string
  if (onboardStep === 'create') {
    const ttlBtn = (sec: number, label: string): string =>
      `<button class="btn small${newCircleTtl === sec ? ' primary' : ''}" data-action="ob-ttl" data-ttl="${sec}">${label}</button>`
    inner = `
      <h1>New circle</h1>
      <p class="tagline">Name it, pick a mode, and choose how long it lasts — ongoing for family, or time-boxed for a trip or a night out.</p>
      <div class="field" style="text-align:left;margin-bottom:14px"><label for="cname">Circle name</label><input class="input" id="cname" placeholder="The Smiths" /></div>
      <div class="mode-toggle" role="group" aria-label="Mode" style="margin-bottom:16px">
        <button data-action="ob-mode" data-mode="family" aria-pressed="${onboardMode === 'family'}">Family</button>
        <button data-action="ob-mode" data-mode="nightout" aria-pressed="${onboardMode === 'nightout'}">Night out</button>
      </div>
      <div class="field" style="text-align:left;margin-bottom:6px"><label>Lifetime</label></div>
      <div class="chip-row" role="group" aria-label="Lifetime" style="margin-bottom:22px;justify-content:center">
        ${ttlBtn(0, 'Ongoing')}${ttlBtn(28_800, 'Tonight')}${ttlBtn(432_000, '5 days')}${ttlBtn(604_800, 'A week')}
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
      <div class="note" style="margin-top:12px">⟳ Waiting for a secure invite…</div>`
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
        qr.addData(fullNpub(persisted.identity.pk))
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
      else if (a === 'back') { onboardStep = 'intro'; awaitingInvite = false; rerenderOnboard() }
      else if (a === 'ob-mode') {
        // Flip the mode in place. A full re-render here would discard whatever's
        // half-typed in the #cname field (it's uncontrolled, read only on create).
        onboardMode = (node as HTMLElement).dataset.mode as Mode
        root.querySelectorAll<HTMLElement>('[data-action="ob-mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === onboardMode)))
      }
      else if (a === 'ob-ttl') {
        // Update in place too, for the same reason as ob-mode.
        newCircleTtl = Number((node as HTMLElement).dataset.ttl)
        root.querySelectorAll<HTMLElement>('[data-action="ob-ttl"]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.ttl) === newCircleTtl))
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
      qr.addData(store.encodeInvite(ac))
      qr.make()
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
    } catch { qrEl.remove() }
  }
  root.querySelectorAll('[data-action]').forEach((node) => {
    if ((node as HTMLElement).closest('#map-panel')) return // wired by wireMapPanel
    const action = node.getAttribute('data-action') as string
    if (action === 'sos-hold') { wireSos(node as HTMLElement); return }
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
  mapView = new MapView(container, fix ?? undefined)
  mapView.setGeofences(persisted.geofences)
  mapView.onMove(() => { if (addMode) updatePreview() })
  updateMapData()
  wireMapPanel()
  requestAnimationFrame(() => mapView?.map.resize())
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
  if (ch) (ch as HTMLElement).hidden = !addMode
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
    return {
      member: e.member,
      lat: d.lat,
      lon: d.lon,
      label: e.member === me ? 'You' : initials(e.member),
      status: st.alerts.has(e.member) ? 'alert' as const : e.status,
    }
  })
}
function updateMapData(): void { mapView?.setMembers(memberPoints()) }

function saveZone(): void {
  if (!mapView) return
  const c = mapView.center()
  persisted.geofences = [...persisted.geofences, { kind: 'circle', centre: { lat: c.lat, lon: c.lon }, radiusMetres: addRadius }]
  store.save(persisted)
  addMode = false
  mapView.setPreview(null)
  mapView.setGeofences(persisted.geofences)
  renderMapPanel()
  toast('Safe zone added')
}

function delZone(i: number): void {
  persisted.geofences = persisted.geofences.filter((_, idx) => idx !== i)
  store.save(persisted)
  mapView?.setGeofences(persisted.geofences)
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
    if (!session.signer.capabilities.hasNip44) { toast('That signer lacks NIP-44 — pick another'); return }
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
  await svc.publishSigned(persisted.relayUrl, wrap as never)
}

// ── Members, invites & reseed ────────────────────────────────────────────────
function members(): string[] { return activeCircle()?.members ?? [] }

function ensureMember(circle: store.Circle, pk: string): void {
  const m = circle.members ?? []
  if (!m.includes(pk)) patchCircleById(circle.id, { members: [...m, pk] })
}

function ensureInviteSub(): void {
  const id = persisted.identity
  if (!id) { stopInviteSub?.(); stopInviteSub = null; inviteSubKey = ''; return }
  const key = `${id.pk}@${persisted.relayUrl}`
  if (key === inviteSubKey && stopInviteSub) return
  stopInviteSub?.()
  inviteSubKey = key
  stopInviteSub = svc.subscribeGiftWraps(persisted.relayUrl, id.pk, (e) => { void onInviteWrap(e) })
}

async function onInviteWrap(e: { pubkey: string; content: string; tags: string[][] }): Promise<void> {
  const signer = getSigner()
  if (!signer) return
  const payload = await readInvite(signer, e)
  if (!payload) return
  if (payload.t === 'invite') {
    if (persisted.circles.some((c) => c.id === payload.id)) return // already a member
    upsertCircle({
      id: payload.id, seedHex: payload.s, name: payload.n, mode: payload.m,
      members: [signer.pubkey], checkinInterval: 0, ...(payload.x ? { expiresAt: payload.x } : {}),
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
    st.beacons.clear(); st.alerts.clear(); st.checkins.clear(); st.rzvStatuses.clear(); st.rendezvous = null
    toast('Circle key was rotated')
    refresh()
  }
}

async function sendInvite(): Promise<void> {
  const c = activeCircle()
  const signer = getSigner()
  if (!c || !signer) return
  const raw = (document.getElementById('invite-npub') as HTMLInputElement | null)?.value?.trim()
  if (!raw) { toast('Paste an npub to invite'); return }
  let pk: string
  try { pk = raw.startsWith('npub') ? store.npubToHex(raw) : raw } catch { toast('Invalid npub'); return }
  if (!/^[0-9a-f]{64}$/.test(pk)) { toast('Invalid key'); return }
  if (pk === signer.pubkey) { toast("That's your own key"); return }
  try {
    const wrap = await buildInviteWrap(signer, pk, { t: 'invite', id: c.id, s: c.seedHex, n: c.name, m: c.mode, ...(c.expiresAt ? { x: c.expiresAt } : {}) })
    await svc.publishSigned(persisted.relayUrl, wrap as never)
    ensureMember(c, pk)
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
      for (const w of wraps) await svc.publishSigned(persisted.relayUrl, w as never)
    }
    patchCircleById(c.id, { seedHex: seed, epoch, members: (c.members ?? []).filter((pk) => pk !== removePk) })
    const st = cstate(c.id)
    st.beacons.clear(); st.alerts.clear(); st.checkins.clear(); st.rzvStatuses.clear(); st.rendezvous = null
    toast(removePk ? 'Member removed & key rotated' : 'Circle key rotated')
    render()
  } catch { toast('Reseed failed') }
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
    missed += missedCheckins(classifyCheckins([...cstate(c.id).checkins.values()], nowSec())).filter((s) => s.member !== me).length
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
    const expired = sweepExpired()
    evaluateCheckinAlarm()
    if (expired && !adding) { toast('A transient circle ended'); render(); return }
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
  const who = activeBuzz.from === persisted.identity?.pk ? 'You' : shortNpub(activeBuzz.from)
  const where = activeBuzz.circle ? ` · ${esc(activeBuzz.circle)}` : ''
  return `<div class="buzz-banner${activeBuzz.mine ? ' for-me' : ''}" data-action="dismiss-buzz" role="alert">
    <span class="bz-icon">🔔</span>
    <span class="bz-text"><strong>${esc(who)}</strong> · ${esc(activeBuzz.reason)}${where}</span>
    <span class="bz-x">✕</span>
  </div>`
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

async function setRendezvous(): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const q = (document.getElementById('rzv-place') as HTMLInputElement | null)?.value?.trim() ?? ''
  let place: Rendezvous['place']
  if (q) {
    toast('Finding the place…')
    const g = await geocode(q)
    if (!g) { toast("Couldn't find that — try a fuller address"); return }
    place = { lat: g.lat, lon: g.lon, label: q, address: g.address, geohash: encode(g.lat, g.lon, 10) }
  } else if (fix) {
    place = { lat: fix.lat, lon: fix.lon, geohash: encode(fix.lat, fix.lon, 10) }
  } else {
    toast('Type a place/address, or start sharing to use your spot'); return
  }
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
    toast('Rendezvous set')
    render()
  } catch { toast('Could not set rendezvous') }
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
      return `<div class="row" style="gap:10px"><span class="avatar small">${isMe ? 'You' : initials(pk)}</span><span class="who" style="font-size:14px">${isMe ? 'You' : shortNpub(pk)}</span><span style="margin-left:auto">${pill}</span></div>`
    }).join('')
    const modes = (['walk', 'cycle', 'drive', 'transit'] as const)
      .map((m) => `<button class="btn small${travelMode === m ? ' primary' : ''}" data-action="rzv-mode" data-mode="${m}">${m}</button>`).join('')
    return `<div class="section-title" style="margin-top:22px">Rendezvous</div>
      <div class="card stack">
        <div class="row" style="justify-content:space-between"><strong>${r.mode === 'be-back' ? 'Be back' : 'Meet'}${dueIn > 0 ? ` in ${fmtMins(dueIn)}` : ' now'}</strong><span class="muted">by ${at}</span></div>
        <div class="note" style="margin-top:-2px">📍 ${esc(r.place.label || r.place.address || 'a set spot')}</div>
        <button class="btn small ghost" data-action="copy-rzv">Copy address for a taxi</button>
        <div class="list">${rows}</div>
        <div class="note">How you're getting there</div>
        <div class="chip-row">${modes}</div>
        ${r.setBy === me ? '<button class="btn small ghost" data-action="clear-rzv">Clear rendezvous</button>' : ''}
      </div>`
  }
  return `<div class="section-title" style="margin-top:22px">Rendezvous</div>
    <div class="card stack">
      <div class="field"><input class="input" id="rzv-place" placeholder="The Crown, or an address — blank for here" autocapitalize="words" autocorrect="off" /></div>
      <div class="note">A place or address (taxi-friendly), or leave blank to use your spot. ETAs are as-the-crow-flies.</div>
      <div class="chip-row">
        <button class="btn small${rzvDurationMin === 30 ? ' primary' : ''}" data-action="rzv-dur" data-min="30">30 min</button>
        <button class="btn small${rzvDurationMin === 60 ? ' primary' : ''}" data-action="rzv-dur" data-min="60">1 hour</button>
        <button class="btn small${rzvDurationMin === 120 ? ' primary' : ''}" data-action="rzv-dur" data-min="120">2 hours</button>
      </div>
      <button class="btn small primary" data-action="set-rzv">Set rendezvous</button>
    </div>`
}

function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'tab': tab = (node.dataset.tab as typeof tab); render(); break
    case 'switch-circle': switchCircle(node.dataset.id as string); break
    case 'add-circle': adding = true; onboardStep = 'intro'; render(); break
    case 'mode': setMode(node.dataset.mode as Mode); break
    case 'toggle-share': sharing ? stopSharing() : startSharing(); break
    case 'pickup': void emit('pickup'); break
    case 'copy-invite': copyInvite(); break
    case 'copy-npub': copyNpub(); break
    case 'send-invite': void sendInvite(); break
    case 'reseed': void reseedCircle(); break
    case 'remove-member': void reseedCircle(node.dataset.pk); break
    case 'checkin': void sendCheckIn(); break
    case 'buzz': void sendBuzz(node.dataset.reason ?? (document.getElementById('buzz-custom') as HTMLInputElement | null)?.value ?? ''); break
    case 'dismiss-buzz': activeBuzz = null; render(); break
    case 'set-rzv': void setRendezvous(); break
    case 'clear-rzv': clearRendezvous(); break
    case 'rzv-dur': rzvDurationMin = Number(node.dataset.min); render(); break
    case 'rzv-mode': travelMode = node.dataset.mode as TravelMode; render(); break
    case 'copy-rzv': copyRzvForTaxi(); break
    case 'arm-menu': armingCheckin = true; render(); break
    case 'cancel-arm': armingCheckin = false; render(); break
    case 'arm': armCheckin(Number(node.dataset.interval)); break
    case 'disarm-checkin': disarmCheckin(); break
    case 'save-relay': saveRelay(); break
    case 'leave': leave(); break
    case 'reset-device': resetDevice(); break
    case 'add-zone': addMode = true; renderMapPanel(); updatePreview(); break
    case 'cancel-zone': addMode = false; mapView?.setPreview(null); renderMapPanel(); break
    case 'save-zone': saveZone(); break
    case 'del-zone': delZone(Number(node.dataset.i)); break
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
  const expiresAt = newCircleTtl ? nowSec() + newCircleTtl : undefined
  upsertCircle(store.createCircle(name, onboardMode, persisted.identity.pk, persisted.circleRootHex, expiresAt), true)
  onboardStep = 'intro'
  awaitingInvite = false
  adding = false
  newCircleTtl = 0
  tab = 'home'
  render()
}

/** Remote join: create an identity, show my npub, and wait for a gift-wrapped invite. */
function doJoinRemote(): void {
  persisted.identity ??= store.createIdentity()
  store.save(persisted)
  awaitingInvite = true
  onboardStep = 'await'
  render()
}

function doJoin(): void {
  const code = (document.getElementById('jcode') as HTMLTextAreaElement | null)?.value ?? ''
  try {
    const circle = store.decodeInvite(code)
    persisted.identity ??= store.createIdentity()
    if (persisted.circles.some((c) => c.id === circle.id)) { switchCircle(circle.id); adding = false; return }
    circle.members = [persisted.identity.pk]
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
  render()
}

function startSharing(): void {
  if (sharing) return
  sharing = true
  stopWatch = svc.watchLocation(onFix, (msg) => { toast(msg); sharing = false; render() })
  render()
}

function stopSharing(): void {
  sharing = false
  breachActive = false
  stopWatch?.()
  stopWatch = null
  render()
}

function onFix(f: svc.Fix): void {
  fix = f
  broadcastRzvStatus()
  const c = activeCircle()
  if (sharing && c?.mode === 'family' && persisted.geofences.length) {
    breachActive = !isWithinAnyFence({ lat: f.lat, lon: f.lon }, persisted.geofences)
    if (breachActive && nowSec() - lastSelfBeacon > 30) { lastSelfBeacon = nowSec(); void emit('none'); return }
  } else if (sharing && c?.mode === 'nightout' && nowSec() - lastSelfBeacon > 45) {
    lastSelfBeacon = nowSec()
    void emit('none')
    return
  }
  refresh()
}

async function emit(trigger: 'none' | 'pickup' | 'help'): Promise<void> {
  const c = activeCircle()
  const id = persisted.identity
  if (!c || !id) return
  const position = fix ? { lat: fix.lat, lon: fix.lon } : null
  const plan = decideEmission({
    mode: c.mode,
    position,
    trigger,
    geofences: c.mode === 'family' ? persisted.geofences : undefined,
  })
  if (plan.reason === 'breach') breachActive = true
  const type = signalTypeForReason(plan.reason)
  if (!type) {
    if (trigger === 'pickup') toast('Need your location first — start sharing.')
    return
  }
  try {
    let template
    if (type === 'help') {
      const location = position
        ? { geohash: encode(position.lat, position.lon, plan.precision), precision: plan.precision, locationSource: 'beacon' as const }
        : null
      template = await buildHelpSignal({ groupId: c.id, seedHex: c.seedHex, member: id.pk, location })
      alertActive = true
    } else {
      if (plan.action === 'withhold' || !position) {
        if (trigger === 'pickup') toast('Need your location first — start sharing.')
        return
      }
      const geohash = encode(position.lat, position.lon, plan.precision)
      template = await buildLocationSignal({ groupId: c.id, seedHex: c.seedHex, signalType: type, geohash, precision: plan.precision })
      cstate(c.id).beacons.set(id.pk, { member: id.pk, geohash, precision: plan.precision, timestamp: nowSec() })
    }
    await publishSignal(template, c)
    toast(trigger === 'help' ? 'Help sent to your circle' : trigger === 'pickup' ? 'Pick-up request sent' : 'Location shared')
  } catch {
    toast('Could not send — check your relay and connection.')
  }
  refresh()
}

function copyInvite(): void {
  const c = activeCircle()
  if (!c) return
  const code = store.encodeInvite(c)
  navigator.clipboard?.writeText(code).then(() => toast('Invite code copied'), () => toast('Copy failed — select it manually'))
}

function copyNpub(): void {
  const id = persisted.identity
  if (!id) return
  let npub = id.pk
  try { npub = npubEncode(id.pk) } catch { /* keep hex */ }
  navigator.clipboard?.writeText(npub).then(() => toast('Your key copied'), () => toast('Copy failed'))
}

function saveRelay(): void {
  const url = (document.getElementById('relay') as HTMLInputElement | null)?.value?.trim()
  if (!url || !url.startsWith('ws')) { toast('Enter a ws:// or wss:// relay URL'); return }
  persisted.relayUrl = url
  store.save(persisted)
  ensureSubscriptions()
  toast('Relay saved')
}

/** Leave just the active circle (local removal). Identity and other circles stay. */
function leave(): void {
  const c = activeCircle()
  if (!c) return
  removeCircle(c.id)
  breachActive = false
  alertActive = false
  tab = 'home'
  toast(`Left ${c.name}`)
  render()
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
  sharing = false
  alertActive = false
  breachActive = false
  checkinAlert = false
  awaitingInvite = false
  armingCheckin = false
  adding = false
  addMode = false
  mapView?.destroy()
  mapView = null
  fix = null
  circleStates.clear()
  persisted = store.load()
  onboardStep = 'intro'
  tab = 'home'
  render()
}

// ── Inbound ──────────────────────────────────────────────────────────────────
function ensureSubscriptions(): void {
  const relay = persisted.relayUrl
  // Desired subs: one per circle, keyed by inbox (a reseed → new inbox → re-subscribe).
  const wanted = new Map<string, store.Circle>()
  for (const c of persisted.circles) {
    const inbox = deriveInbox(c.seedHex)
    wanted.set(`${c.id}@${relay}@${inbox.pk}`, c)
  }
  for (const [key, stop] of subs) if (!wanted.has(key)) { stop(); subs.delete(key) }
  for (const [key, c] of wanted) {
    if (subs.has(key)) continue
    const inbox = deriveInbox(c.seedHex)
    const circleId = c.id
    subs.set(key, svc.subscribeGiftWraps(relay, inbox.pk, (wrap) => { void onSignalWrap(circleId, wrap, inbox.sk) }))
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
      st.alerts.set(who, e.created_at)
      if (!me || e.pubkey !== me.pk) { alertActive = true; toast(`🚨 Help raised in ${c.name}`) }
      if (a.geohash) st.beacons.set(who, { member: who, geohash: a.geohash, precision: a.precision, timestamp: a.timestamp || e.created_at })
    } else if (t === 'beacon' || t === 'breach' || t === 'pickup') {
      const p = await decryptBeacon(deriveBeaconKey(c.seedHex), e.content)
      st.beacons.set(e.pubkey, { member: e.pubkey, geohash: p.geohash, precision: p.precision, timestamp: p.timestamp || e.created_at })
      if (t === 'pickup' && (!me || e.pubkey !== me.pk)) toast(`Pick-up request in ${c.name}`)
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
    } else if (t === RENDEZVOUS_STATUS_TYPE) {
      const status = await decryptRendezvousStatus(c.seedHex, e.content)
      st.rzvStatuses.set(status.member, status)
      if (status.status === 'at-risk' && st.rendezvous?.setBy === me?.pk && status.member !== me?.pk) {
        toast(`⚠ ${shortNpub(status.member)} may miss the rendezvous`)
      }
    } else {
      return
    }
    ensureMember(c, e.pubkey)
    refresh()
  } catch {
    /* not for us, or undecryptable */
  }
}
