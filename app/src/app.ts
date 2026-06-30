// flock PWA — UI controller. Vanilla TS, render-on-state. Wires the flock
// library (decideEmission → build signal) to real Nostr publish/subscribe.

import * as store from './store'
import type { Mode } from './store'
import * as svc from './services'
import { encode, decode } from 'geohash-kit'
import qrcode from 'qrcode-generator'
import { npubEncode } from 'nostr-tools/nip19'
import type { MapView, MapPoint } from './map'
import {
  decideEmission,
  signalTypeForReason,
  buildLocationSignal,
  buildHelpSignal,
  classifyPresence,
  isWithinAnyFence,
  deriveBeaconKey,
  decryptBeacon,
  deriveDuressKey,
  decryptDuressAlert,
  hashGroupId,
  type MemberBeacon,
  type CircleGeofence,
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

let onboardStep: 'intro' | 'create' | 'join' = 'intro'
let onboardMode: Mode = 'family'

const beacons = new Map<string, MemberBeacon>()
const alerts = new Map<string, number>()

// ── Helpers ────────────────────────────────────────────────────────────────
const nowSec = (): number => Math.floor(Date.now() / 1000)
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

function shortNpub(pk: string): string {
  try { const n = npubEncode(pk); return `${n.slice(0, 10)}…${n.slice(-4)}` } catch { return pk.slice(0, 10) }
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
}

function render(): void {
  if (tab !== 'map' && mapView) { mapView.destroy(); mapView = null; addMode = false }
  if (!persisted.identity || !persisted.circle) {
    root.innerHTML = onboardingView()
    wireOnboard()
    return
  }
  ensureSubscription()
  const body = tab === 'home' ? homeView() : tab === 'map' ? mapView_screen() : tab === 'circle' ? circleView() : youView()
  root.innerHTML = `<main class="screen fade-in ${tab === 'map' ? 'map-screen' : ''}">${body}</main>${navView()}<div class="toast" id="toast"></div>`
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
    </div>`
}

function memberRow(e: ReturnType<typeof classifyPresence>[number], mePk: string): string {
  const isMe = e.member === mePk
  const alerted = alerts.has(e.member)
  const pill = alerted
    ? '<span class="pill alert">help</span>'
    : e.status === 'active'
      ? `<span class="pill active">out · ${fmtAgo(e.ageSeconds)}</span>`
      : `<span class="pill stale">home · ${fmtAgo(e.ageSeconds)}</span>`
  return `<div class="member">
    <div class="avatar">${isMe ? 'You' : initials(e.member)}</div>
    <div class="meta"><div class="who">${isMe ? 'You' : shortNpub(e.member)}</div><div class="when">~${esc(e.geohash)}</div></div>
    ${pill}
  </div>`
}

function circleView(): string {
  const c = persisted.circle as store.Circle
  const me = persisted.identity as store.Identity
  const entries = classifyPresence([...beacons.values()], nowSec(), { staleAfterSeconds: 600 })
  const rows = entries.length
    ? entries.map((e) => memberRow(e, me.pk)).join('')
    : '<div class="card muted">No-one has shared yet. Send an invite, then start sharing from Home.</div>'
  return `
    ${topbar(false)}
    <h2 style="margin-bottom:14px">${esc(c.name)}</h2>
    <div class="section-title">Who's out</div>
    <div class="list">${rows}</div>
    <div class="section-title" style="margin-top:22px">Invite people</div>
    <div class="card stack">
      <div class="qr" id="qr"></div>
      <div class="invite-code" id="invite-code">${esc(store.encodeInvite(c))}</div>
      <button class="btn small" data-action="copy-invite">Copy invite code</button>
      <div class="note">Anyone with this code can join the circle and read its shared locations. Share it privately.</div>
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
      <div class="note">Stored on this device only. This preview keeps the key in local storage — not secure key storage. Don't rely on it for real safety yet.</div>
    </div>
    <div class="section-title" style="margin-top:18px">Relay</div>
    <div class="card stack">
      <div class="field"><label for="relay">Nostr relay</label><input class="input" id="relay" value="${esc(persisted.relayUrl)}" autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
      <button class="btn small" data-action="save-relay">Save relay</button>
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
      <p class="tagline">Paste the invite code someone shared with you.</p>
      <div class="field" style="text-align:left;margin-bottom:20px"><label for="jcode">Invite code</label><textarea class="input" id="jcode" rows="4" placeholder="Paste code…"></textarea></div>
      <div class="actions">
        <button class="btn primary" data-action="do-join">Join circle</button>
        <button class="btn ghost" data-action="back">Back</button>
      </div>`
  } else {
    inner = `
      <img class="hero-logo" src="./icon.svg" alt="" />
      <h1>Stay close,<br/>stay private.</h1>
      <p class="tagline">Your location stays hidden — shared only when you ask for a pick-up, raise help, or step outside a safe area.</p>
      <div class="actions">
        <button class="btn primary" data-action="create">Create a circle</button>
        <button class="btn ghost" data-action="join">Join with a code</button>
      </div>`
  }
  return `<main class="screen onboard fade-in">${inner}</main><div class="toast" id="toast"></div>`
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function wireOnboard(): void {
  root.querySelectorAll('[data-action]').forEach((node) => {
    node.addEventListener('click', () => {
      const a = node.getAttribute('data-action')
      if (a === 'create') { onboardStep = 'create'; rerenderOnboard() }
      else if (a === 'join') { onboardStep = 'join'; rerenderOnboard() }
      else if (a === 'back') { onboardStep = 'intro'; rerenderOnboard() }
      else if (a === 'ob-mode') { onboardMode = (node as HTMLElement).dataset.mode as Mode; rerenderOnboard() }
      else if (a === 'do-create') doCreate()
      else if (a === 'do-join') doJoin()
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

function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'tab': tab = (node.dataset.tab as typeof tab); render(); break
    case 'mode': setMode(node.dataset.mode as Mode); break
    case 'toggle-share': sharing ? stopSharing() : startSharing(); break
    case 'pickup': void emit('pickup'); break
    case 'copy-invite': copyInvite(); break
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
  persisted.circle = store.createCircle(name, onboardMode)
  store.save(persisted)
  onboardStep = 'intro'
  tab = 'home'
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
    await svc.publishEvent(persisted.relayUrl, template, id.skHex)
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

function saveRelay(): void {
  const url = (document.getElementById('relay') as HTMLInputElement | null)?.value?.trim()
  if (!url || !url.startsWith('ws')) { toast('Enter a ws:// or wss:// relay URL'); return }
  persisted.relayUrl = url
  store.save(persisted)
  ensureSubscription()
  toast('Relay saved')
}

function leave(): void {
  store.reset()
  stopWatch?.(); stopWatch = null
  stopSub?.(); stopSub = null
  subKey = ''
  sharing = false
  alertActive = false
  breachActive = false
  addMode = false
  mapView?.destroy()
  mapView = null
  fix = null
  beacons.clear()
  alerts.clear()
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
    } else {
      return
    }
    refresh()
  } catch {
    /* not for us, or undecryptable */
  }
}
