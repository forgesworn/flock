// flock PWA — UI controller. Vanilla TS, render-on-state. Wires the flock
// library (decideEmission → build signal) to real Nostr publish/subscribe.

import * as store from './store'
import type { Mode } from './store'
import * as svc from './services'
import { makeLocalSigner, makeSignetSigner, type FlockSigner } from './signer'
import { login as signetLogin, restoreSession as signetRestore, logout as signetLogout } from 'signet-login'
import { PRIVATE_RELAYS } from './relays'
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
  deriveBeaconKey,
  decryptBeacon,
  deriveDuressKey,
  decryptDuressAlert,
  hashGroupId,
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
let stopSub: (() => void) | null = null
let subKey = ''
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
let activeBuzz: { from: string; reason: string; mine: boolean } | null = null

let onboardStep: 'intro' | 'create' | 'join' | 'await' = 'intro'
let onboardMode: Mode = 'family'

const beacons = new Map<string, MemberBeacon>()
const alerts = new Map<string, number>()
const checkins = new Map<string, CheckIn>()

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
  render()
  void restoreSignet()
}

function render(): void {
  if (tab !== 'map' && mapView) { mapView.destroy(); mapView = null; addMode = false }
  if (persisted.identity) ensureInviteSub()
  if (!persisted.identity || !persisted.circle) {
    root.innerHTML = onboardingView()
    wireOnboard()
    return
  }
  ensureMember(persisted.identity.pk)
  ensureSubscription()
  startMonitor()
  const body = tab === 'home' ? homeView() : tab === 'map' ? mapView_screen() : tab === 'circle' ? circleView() : youView()
  root.innerHTML = `${buzzBanner()}<main class="screen fade-in ${tab === 'map' ? 'map-screen' : ''}">${body}</main>${navView()}<div class="toast" id="toast"></div>`
  wireApp()
}

// ── Views: app ───────────────────────────────────────────────────────────────
function topbar(showModeToggle: boolean): string {
  const c = persisted.circle as store.Circle
  const toggle = showModeToggle ? `
    <div class="mode-toggle" role="group" aria-label="Mode">
      <button data-action="mode" data-mode="family" aria-pressed="${c.mode === 'family'}">Family</button>
      <button data-action="mode" data-mode="nightout" aria-pressed="${c.mode === 'nightout'}">Night out</button>
    </div>` : ''
  return `<div class="topbar">
    <div class="brand"><img class="logo" src="./icon.svg" alt=""/><span class="name wordmark">flock</span></div>
    ${toggle}
  </div>`
}

function orbState(): { cls: string; label: string; sub: string } {
  const c = persisted.circle as store.Circle
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
  const c = persisted.circle as store.Circle
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
  const c = persisted.circle as store.Circle
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
    const mine = me ? checkins.get(me) : undefined
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
  const isMe = pk === mePk
  const beacon = beacons.get(pk)
  const presence = beacon ? classifyPresence([beacon], nowSec(), { staleAfterSeconds: 600 })[0] : null
  const ci = checkins.get(pk)
  const ciState = ci ? classifyCheckins([ci], nowSec())[0] : null

  let pill: string
  if (alerts.has(pk)) pill = '<span class="pill alert">help</span>'
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
  const c = persisted.circle as store.Circle
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
  const c = persisted.circle as store.Circle
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
    <div class="section-title" style="margin-top:18px">Circle</div>
    <div class="card stack">
      <div class="kv"><span class="k">Name</span><span>${esc(c.name)}</span></div>
      <div class="kv"><span class="k">Mode</span><span>${c.mode === 'nightout' ? 'Night out' : 'Family'}</span></div>
      <button class="btn ghost" data-action="leave">Leave circle &amp; reset</button>
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
    inner = `
      <h1>New circle</h1>
      <p class="tagline">Give it a name. You can switch between family and night-out mode any time.</p>
      <div class="field" style="text-align:left;margin-bottom:14px"><label for="cname">Circle name</label><input class="input" id="cname" placeholder="The Smiths" /></div>
      <div class="mode-toggle" role="group" aria-label="Mode" style="margin-bottom:22px">
        <button data-action="ob-mode" data-mode="family" aria-pressed="${onboardMode === 'family'}">Family</button>
        <button data-action="ob-mode" data-mode="nightout" aria-pressed="${onboardMode === 'nightout'}">Night out</button>
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
      else if (a === 'ob-mode') { onboardMode = (node as HTMLElement).dataset.mode as Mode; rerenderOnboard() }
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
  if (qrEl && persisted.circle) {
    try {
      const qr = qrcode(0, 'M')
      qr.addData(store.encodeInvite(persisted.circle))
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
  return classifyPresence([...beacons.values()], nowSec(), { staleAfterSeconds: 600 }).map((e) => {
    const d = decode(e.geohash)
    return {
      member: e.member,
      lat: d.lat,
      lon: d.lon,
      label: e.member === me ? 'You' : initials(e.member),
      status: alerts.has(e.member) ? 'alert' as const : e.status,
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

// ── Members, invites & reseed ────────────────────────────────────────────────
function members(): string[] { return persisted.circle?.members ?? [] }

function ensureMember(pk: string): void {
  const c = persisted.circle
  if (!c) return
  const m = c.members ?? []
  if (!m.includes(pk)) { c.members = [...m, pk]; store.save(persisted) }
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
    if (persisted.circle && persisted.circle.id === payload.id) return
    persisted.circle = { id: payload.id, seedHex: payload.s, name: payload.n, mode: payload.m, members: [signer.pubkey], checkinInterval: 0 }
    store.save(persisted)
    beacons.clear(); alerts.clear(); checkins.clear()
    awaitingInvite = false
    onboardStep = 'intro'
    tab = 'home'
    toast(`You've joined ${payload.n}`)
    render()
  } else if (payload.t === 'reseed' && persisted.circle && payload.id === persisted.circle.id) {
    persisted.circle = { ...persisted.circle, seedHex: payload.s }
    store.save(persisted)
    beacons.clear(); alerts.clear(); checkins.clear()
    toast('Circle key was rotated')
    refresh()
  }
}

async function sendInvite(): Promise<void> {
  const c = persisted.circle
  const signer = getSigner()
  if (!c || !signer) return
  const raw = (document.getElementById('invite-npub') as HTMLInputElement | null)?.value?.trim()
  if (!raw) { toast('Paste an npub to invite'); return }
  let pk: string
  try { pk = raw.startsWith('npub') ? store.npubToHex(raw) : raw } catch { toast('Invalid npub'); return }
  if (!/^[0-9a-f]{64}$/.test(pk)) { toast('Invalid key'); return }
  if (pk === signer.pubkey) { toast("That's your own key"); return }
  try {
    const wrap = await buildInviteWrap(signer, pk, { t: 'invite', id: c.id, s: c.seedHex, n: c.name, m: c.mode })
    await svc.publishSigned(persisted.relayUrl, wrap as never)
    ensureMember(pk)
    toast('Secure invite sent')
    render()
  } catch { toast('Could not send invite') }
}

async function reseedCircle(removePk?: string): Promise<void> {
  const c = persisted.circle
  const signer = getSigner()
  if (!c || !signer) return
  const seed = store.newSeed()
  const recipients = (c.members ?? []).filter((pk) => pk !== signer.pubkey && pk !== removePk)
  try {
    if (recipients.length) {
      const wraps = await buildReseedWraps(signer, recipients, { t: 'reseed', id: c.id, s: seed, n: c.name, m: c.mode })
      for (const w of wraps) await svc.publishSigned(persisted.relayUrl, w as never)
    }
    persisted.circle = { ...c, seedHex: seed, members: (c.members ?? []).filter((pk) => pk !== removePk) }
    store.save(persisted)
    beacons.clear(); alerts.clear(); checkins.clear()
    toast(removePk ? 'Member removed & key rotated' : 'Circle key rotated')
    render()
  } catch { toast('Reseed failed') }
}

// ── Check-in / dead-man's-switch ─────────────────────────────────────────────
async function sendCheckIn(): Promise<void> {
  const c = persisted.circle
  const id = persisted.identity
  if (!c || !id) return
  const interval = c.checkinInterval ?? 0
  try {
    const tmpl = await buildCheckInSignal({ groupId: c.id, seedHex: c.seedHex, member: id.pk, intervalSeconds: interval })
    await svc.publishEvent(persisted.relayUrl, tmpl, getSigner() as FlockSigner)
    if (interval > 0) checkins.set(id.pk, { member: id.pk, timestamp: nowSec(), intervalSeconds: interval })
    else checkins.delete(id.pk)
    toast(interval > 0 ? "Checked in — you're OK" : 'Checked out')
  } catch { toast('Check-in failed') }
  refresh()
}

function armCheckin(intervalSeconds: number): void {
  if (!persisted.circle) return
  persisted.circle = { ...persisted.circle, checkinInterval: intervalSeconds }
  store.save(persisted)
  armingCheckin = false
  startMonitor()
  void sendCheckIn()
}

function disarmCheckin(): void {
  if (!persisted.circle) return
  persisted.circle = { ...persisted.circle, checkinInterval: 0 }
  store.save(persisted)
  void sendCheckIn() // broadcasts a stand-down (interval 0)
}

function evaluateCheckinAlarm(): void {
  const me = persisted.identity?.pk
  const missed = missedCheckins(classifyCheckins([...checkins.values()], nowSec())).filter((s) => s.member !== me)
  const was = checkinAlert
  checkinAlert = missed.length > 0
  if (checkinAlert && !was) toast(`⚠ ${missed.length === 1 ? 'A member' : `${missed.length} members`} missed a check-in`)
}

function isEditing(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

function startMonitor(): void {
  if (monitorTimer) return
  monitorTimer = window.setInterval(() => {
    evaluateCheckinAlarm()
    if (!isEditing()) refresh()
  }, 30_000)
}

// ── Buzz ─────────────────────────────────────────────────────────────────────
async function sendBuzz(reason: string, target?: string): Promise<void> {
  const c = persisted.circle
  const id = persisted.identity
  if (!c || !id) return
  const r = reason.trim()
  if (!r) { toast('Pick or type a reason'); return }
  try {
    const tmpl = await buildBuzzSignal({ groupId: c.id, seedHex: c.seedHex, from: id.pk, reason: r, ...(target ? { target } : {}) })
    await svc.publishEvent(persisted.relayUrl, tmpl, getSigner() as FlockSigner)
    toast(target ? 'Buzzed' : 'Buzzed everyone')
  } catch { toast('Buzz failed') }
}

function buzzBanner(): string {
  if (!activeBuzz) return ''
  const who = activeBuzz.from === persisted.identity?.pk ? 'You' : shortNpub(activeBuzz.from)
  return `<div class="buzz-banner${activeBuzz.mine ? ' for-me' : ''}" data-action="dismiss-buzz" role="alert">
    <span class="bz-icon">🔔</span>
    <span class="bz-text"><strong>${esc(who)}</strong> · ${esc(activeBuzz.reason)}</span>
    <span class="bz-x">✕</span>
  </div>`
}

function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'tab': tab = (node.dataset.tab as typeof tab); render(); break
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
    case 'arm-menu': armingCheckin = true; render(); break
    case 'cancel-arm': armingCheckin = false; render(); break
    case 'arm': armCheckin(Number(node.dataset.interval)); break
    case 'disarm-checkin': disarmCheckin(); break
    case 'save-relay': saveRelay(); break
    case 'leave': leave(); break
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
  persisted.circle = store.createCircle(name, onboardMode, persisted.identity.pk)
  store.save(persisted)
  onboardStep = 'intro'
  awaitingInvite = false
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
    persisted.circle = circle
    store.save(persisted)
    onboardStep = 'intro'
    tab = 'home'
    render()
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Invalid invite code.')
  }
}

function setMode(mode: Mode): void {
  if (!persisted.circle) return
  persisted.circle = { ...persisted.circle, mode }
  store.save(persisted)
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
  const c = persisted.circle
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
  const c = persisted.circle
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
      beacons.set(id.pk, { member: id.pk, geohash, precision: plan.precision, timestamp: nowSec() })
    }
    await svc.publishEvent(persisted.relayUrl, template, getSigner() as FlockSigner)
    toast(trigger === 'help' ? 'Help sent to your circle' : trigger === 'pickup' ? 'Pick-up request sent' : 'Location shared')
  } catch {
    toast('Could not send — check your relay and connection.')
  }
  refresh()
}

function copyInvite(): void {
  if (!persisted.circle) return
  const code = store.encodeInvite(persisted.circle)
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
  ensureSubscription()
  toast('Relay saved')
}

function leave(): void {
  if (persisted.authMethod === 'signet') { try { void signetLogout() } catch { /* ignore */ } }
  signetSigner = null
  store.reset()
  stopWatch?.(); stopWatch = null
  stopSub?.(); stopSub = null
  stopInviteSub?.(); stopInviteSub = null
  subKey = ''
  inviteSubKey = ''
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = 0 }
  sharing = false
  alertActive = false
  breachActive = false
  checkinAlert = false
  awaitingInvite = false
  armingCheckin = false
  addMode = false
  mapView?.destroy()
  mapView = null
  fix = null
  beacons.clear()
  alerts.clear()
  checkins.clear()
  persisted = store.load()
  onboardStep = 'intro'
  tab = 'home'
  render()
}

// ── Inbound ──────────────────────────────────────────────────────────────────
function ensureSubscription(): void {
  const c = persisted.circle
  if (!c) { stopSub?.(); stopSub = null; subKey = ''; return }
  const key = `${c.id}@${persisted.relayUrl}`
  if (key === subKey && stopSub) return
  stopSub?.()
  subKey = key
  const dTag = `ssg/${hashGroupId(c.id)}`
  stopSub = svc.subscribeSignals(persisted.relayUrl, dTag, (e) => { void onIncoming(e) })
}

async function onIncoming(e: { pubkey: string; content: string; tags: string[][]; created_at: number }): Promise<void> {
  const c = persisted.circle
  const me = persisted.identity
  if (!c) return
  const t = e.tags.find((x) => x[0] === 't')?.[1]
  try {
    if (t === 'help') {
      const a = await decryptDuressAlert(deriveDuressKey(c.seedHex), e.content)
      const who = a.member || e.pubkey
      alerts.set(who, e.created_at)
      if (!me || e.pubkey !== me.pk) { alertActive = true; toast('🚨 Help raised in your circle') }
      if (a.geohash) beacons.set(who, { member: who, geohash: a.geohash, precision: a.precision, timestamp: a.timestamp || e.created_at })
    } else if (t === 'beacon' || t === 'breach' || t === 'pickup') {
      const p = await decryptBeacon(deriveBeaconKey(c.seedHex), e.content)
      beacons.set(e.pubkey, { member: e.pubkey, geohash: p.geohash, precision: p.precision, timestamp: p.timestamp || e.created_at })
      if (t === 'pickup' && (!me || e.pubkey !== me.pk)) toast('Pick-up request from your circle')
    } else if (t === CHECKIN_SIGNAL_TYPE) {
      const ci = await decryptCheckIn(c.seedHex, e.content)
      checkins.set(ci.member, ci)
      evaluateCheckinAlarm()
    } else if (t === 'buzz') {
      const bz = await decryptBuzz(c.seedHex, e.content)
      if (!me || bz.from !== me.pk) {
        const mine = !!me && bz.target === me.pk
        activeBuzz = { from: bz.from, reason: bz.reason, mine }
        try { navigator.vibrate?.(mine ? [300, 120, 300, 120, 300] : [200, 100, 200]) } catch { /* no haptics */ }
      }
    } else {
      return
    }
    ensureMember(e.pubkey)
    refresh()
  } catch {
    /* not for us, or undecryptable */
  }
}
