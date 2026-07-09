// Radar mode — the foreground Alien-inspired motion tracker. One selected
// person, one dominant scope, one obvious Stop. The controller owns the DOM
// overlay, the compass/orientation listener, the Web Audio beeper and the
// vibration mirror; every DECISION (state, cue, movement, honesty rules) comes
// from the pure library module (src/radar.ts) so it stays tested.
//
// Privacy: this consumes ONLY the already-disclosed beacon the host hands it —
// it never publishes, never changes anyone's precision or cadence, and a
// coarse/stale/withheld target degrades the cue instead of pointing precisely
// (docs/plans/2026-07-09-radar-navigation-goal.md). Foreground only: locked-
// phone guidance is a separate native slice, deliberately not promised here.

import {
  radarGuidance,
  cueFor,
  targetMoved,
  courseFromFixes,
  classifyFreshness,
  type RadarCue,
  type RadarGuidance,
  type TimedPosition,
} from '@forgesworn/flock'
import { headingFromOrientation, blipXY, niceRange, freshnessLabel, statusCopy } from './radarView'
import { isNativeShell } from './native'

/** The disclosed observation the host feeds the radar each tick. */
export interface RadarTargetFeed {
  lat: number
  lon: number
  /** Disclosed uncertainty radius (the precision's cell size), metres. */
  uncertaintyMetres: number
  /** Unix seconds of the beacon. */
  timestamp: number
}

export interface RadarHost {
  /** Overlay layer the tracker mounts into (survives app re-renders). */
  layer: HTMLElement
  /** Which disclosure this radar consumes — lets the beacon path notify us. */
  targetKey: { circleId: string; pk: string }
  targetName: () => string
  /** The selected member's latest already-permitted disclosure, or null. */
  getTarget: () => RadarTargetFeed | null
  /** My own latest fix (purely local consumption), or null. */
  getMyFix: () => { lat: number; lon: number; at: number } | null
  /** Begin a local-only fix source if the app isn't sampling already; returns
   *  a stop fn (noop when the app's own watch is running). */
  startLocalFix: () => () => void
  /** Render metres in the user's units. */
  fmtDistance: (metres: number) => string
  onClosed: () => void
}

const TICK_MS = 500
/** A GPS course over ground is only trusted this long after the fix that made it. */
const COURSE_MAX_AGE_SEC = 30

interface RadarSession {
  host: RadarHost
  el: HTMLElement
  stopLocalFix: () => void
  tickTimer: number
  beepTimer: number
  removeOrientation: () => void
  audio: AudioContext | null
  muted: boolean
  cue: RadarCue
  compassHeading: number | null
  lastFixes: TimedPosition[]
  lastObservation: { position: { lat: number; lon: number }; uncertaintyMetres: number; timestamp: number } | null
  lastState: RadarGuidance['state'] | null
  /** The scope's current full-scale range — niceRange's hysteresis memory. */
  rangeMetres: number | null
  /** Native locked-phone guide running (Android shell): it owns ALL audio +
   *  haptics for the session so the two sources never double-beep; JS keeps
   *  the visuals. */
  nativeGuide: boolean
  nativeCheck: number
  closed: boolean
}

/** The native guide bridge, when the shell provides it (lazy, cached). */
const nativeGuideApi = async (): Promise<typeof import('../../native/radarGuide') | null> => {
  if (!isNativeShell()) return null
  try { return await import('../../native/radarGuide') } catch { return null }
}

let session: RadarSession | null = null

export function isRadarOpen(): boolean {
  return session !== null
}

/** Stop everything NOW — audio, haptics, sensors, DOM. Safe to call twice. */
export function closeRadar(): void {
  const s = session
  if (!s || s.closed) return
  s.closed = true
  session = null
  window.clearInterval(s.tickTimer)
  window.clearTimeout(s.beepTimer)
  s.removeOrientation()
  s.stopLocalFix()
  try { navigator.vibrate?.(0) } catch { /* no haptics */ }
  void s.audio?.close().catch(() => { /* already closed */ })
  if (s.nativeGuide) void nativeGuideApi().then((m) => m?.stopRadarGuide())
  s.el.remove()
  s.host.onClosed()
}

/** A beacon just landed for (circleId, member) — if it's this radar's target,
 *  sync NOW. Event-driven on purpose: while the phone is locked the WebView's
 *  timers are throttled/suspended, but the relay socket's message handler
 *  still runs (battery-exempt), so this is the path that keeps the NATIVE
 *  guide's target fresh. No radar open / different member → no-op. */
export function radarBeaconLanded(circleId: string, member: string): void {
  const s = session
  if (!s || s.closed) return
  if (s.host.targetKey.circleId !== circleId || s.host.targetKey.pk !== member) return
  syncTarget(s)
}

export function openRadar(host: RadarHost): void {
  closeRadar()
  const el = mountRadar(host)
  session = {
    host,
    el,
    stopLocalFix: host.startLocalFix(),
    tickTimer: 0,
    beepTimer: 0,
    removeOrientation: () => { /* replaced below */ },
    audio: null,
    muted: false,
    cue: { pattern: 'silent', periodMs: 0, toneHz: 0, vibrateMs: [] },
    compassHeading: null,
    lastFixes: [],
    lastObservation: null,
    lastState: null,
    rangeMetres: null,
    nativeGuide: false,
    nativeCheck: 0,
    closed: false,
  }
  const s = session
  // The open tap is the user gesture audio needs — create the context here.
  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    const C = Ctx.AudioContext ?? Ctx.webkitAudioContext
    if (C) s.audio = new C()
  } catch { /* no audio — haptics + visuals still work */ }
  // Android shell: hand audio/haptics to the native guide so the beeps keep
  // going when the screen locks (the WebView's timers don't). JS keeps the
  // visuals; the pure core is the same on both sides (golden vectors).
  void nativeGuideApi().then((m) => {
    if (!m || s.closed) return
    const t = host.getTarget()
    void m.startRadarGuide(t ? { lat: t.lat, lon: t.lon, uncertaintyMetres: t.uncertaintyMetres, timestampMs: t.timestamp * 1000 } : null, s.muted)
      .then(() => { if (s.closed) void m.stopRadarGuide(); else s.nativeGuide = true })
  })
  void startOrientation(s)
  tick(s)
  s.tickTimer = window.setInterval(() => tick(s), TICK_MS)
  beepLoop(s)
}

// ── Sensors ──────────────────────────────────────────────────────────────────

const screenAngle = (): number => (typeof screen !== 'undefined' && screen.orientation?.angle) || 0

/** Compass heading via DeviceOrientation. iOS 13+ needs a permission call from
 *  a user gesture — the open tap qualifies. A denied/missing compass simply
 *  leaves heading null: the radar honestly falls back to walk-a-few-steps. */
async function startOrientation(s: RadarSession): Promise<void> {
  const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
  if (typeof D?.requestPermission === 'function') {
    try { if (await D.requestPermission() !== 'granted') return } catch { return }
  }
  if (s.closed) return
  const onEvent = (e: DeviceOrientationEvent): void => {
    const webkit = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading
    s.compassHeading = headingFromOrientation(
      { alpha: e.alpha, absolute: e.absolute, webkitCompassHeading: webkit },
      screenAngle(),
    )
  }
  // Prefer the earth-referenced event where the platform provides it.
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
  window.addEventListener(type, onEvent as EventListener)
  s.removeOrientation = () => window.removeEventListener(type, onEvent as EventListener)
}

/** Device heading for guidance: the compass when it's live, else a GPS course
 *  over ground from my own recent movement (the "walk a few steps" fallback). */
function effectiveHeading(s: RadarSession): number | null {
  if (s.compassHeading !== null) return s.compassHeading
  const [prev, cur] = s.lastFixes
  if (!prev || !cur) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec - cur.atSec > COURSE_MAX_AGE_SEC) return null
  return courseFromFixes(prev, cur)
}

// ── The tick: state → DOM + cue ──────────────────────────────────────────────

/** Pull the target's latest disclosure: fire the moved interrupt on a genuine
 *  move, remember the observation, and forward it to the native guide (which
 *  runs the same pure rules for its own moved pulse). Called every tick AND
 *  directly from the beacon path (radarBeaconLanded) so a locked phone's
 *  native guide stays fresh without JS timers. */
function syncTarget(s: RadarSession): void {
  const t = s.host.getTarget()
  if (!t) return
  if (s.lastObservation && t.timestamp !== s.lastObservation.timestamp) {
    // A genuinely fresher beacon that MOVED gets its own interrupt — the user
    // must feel the direction change without looking (goal §6).
    if (targetMoved(s.lastObservation, { position: { lat: t.lat, lon: t.lon }, uncertaintyMetres: t.uncertaintyMetres })) {
      movedPulse(s)
    }
    if (s.nativeGuide) {
      void nativeGuideApi().then((m) =>
        m?.updateRadarTarget({ lat: t.lat, lon: t.lon, uncertaintyMetres: t.uncertaintyMetres, timestampMs: t.timestamp * 1000 }))
    }
  }
  s.lastObservation = { position: { lat: t.lat, lon: t.lon }, uncertaintyMetres: t.uncertaintyMetres, timestamp: t.timestamp }
}

function tick(s: RadarSession): void {
  if (s.closed) return
  const nowSec = Math.floor(Date.now() / 1000)
  const my = s.host.getMyFix()
  if (my) {
    const last = s.lastFixes[s.lastFixes.length - 1]
    if (!last || last.atSec !== my.at) {
      s.lastFixes = [...s.lastFixes.slice(-1), { position: { lat: my.lat, lon: my.lon }, atSec: my.at }]
    }
  }

  syncTarget(s)
  const t = s.host.getTarget()
  const target = t
    ? { position: { lat: t.lat, lon: t.lon }, uncertaintyMetres: t.uncertaintyMetres, ageSeconds: Math.max(0, nowSec - t.timestamp) }
    : null

  // The native guide's notification has its own Stop — if the user ended the
  // session from the lock screen, the reopened tracker must not linger.
  if (s.nativeGuide && !document.hidden && ++s.nativeCheck % 4 === 0) {
    void nativeGuideApi().then((m) => m?.isRadarGuideActive().then((active) => {
      if (!active && session === s && !s.closed) closeRadar()
    }))
  }

  const heading = effectiveHeading(s)
  const g = radarGuidance({
    me: my ? { lat: my.lat, lon: my.lon } : null,
    headingDeg: heading,
    target,
  })

  // Arrival: silence immediately, one short confirmation haptic (goal §4).
  // With the native guide running, IT owns the haptic (same rule, same core).
  if (g.state === 'arrived' && s.lastState !== 'arrived' && !s.nativeGuide) {
    try { navigator.vibrate?.(cueFor(g).vibrateMs) } catch { /* no haptics */ }
  }
  s.lastState = g.state
  s.cue = cueFor(g)
  patchScope(s, g, target?.ageSeconds ?? null, heading)
}

function patchScope(s: RadarSession, g: RadarGuidance, ageSeconds: number | null, heading: number | null): void {
  const q = (id: string): HTMLElement | null => s.el.querySelector(`#${id}`)
  const scope = q('radar-scope')
  const blip = q('radar-blip')
  const uncert = q('radar-uncert')
  const north = q('radar-north')
  const fresh = q('radar-fresh')
  const distance = q('radar-distance')
  const status = q('radar-status')
  const range = q('radar-range')
  if (!scope || !blip) return

  const rangeMetres = niceRange(g.distanceMetres, g.uncertaintyMetres ?? 0, s.rangeMetres)
  s.rangeMetres = rangeMetres
  if (range) range.textContent = s.host.fmtDistance(rangeMetres).replace('~', '')

  // Freshness readout + scope mood.
  if (fresh) {
    fresh.textContent = ageSeconds === null ? 'no signal' : freshnessLabel(ageSeconds)
    fresh.dataset.tone = ageSeconds === null ? 'stale' : classifyFreshness(ageSeconds)
  }
  scope.dataset.state = g.state

  // Blip: heading-up when we have a heading, north-up otherwise.
  const angle = g.relativeBearingDeg ?? g.bearingDeg
  if (g.distanceMetres !== null && angle !== null) {
    const radius = scope.clientWidth / 2
    const { x, y } = blipXY(angle, g.distanceMetres, rangeMetres)
    blip.hidden = false
    blip.style.transform = `translate(calc(-50% + ${(x * radius).toFixed(1)}px), calc(-50% + ${(y * radius).toFixed(1)}px))`
    blip.dataset.tone = g.freshness ?? 'stale'
    // The honesty band: how loosely the disclosure places them, at scope scale.
    if (uncert) {
      const u = g.uncertaintyMetres ?? 0
      const px = Math.max(8, (u / rangeMetres) * radius * 2)
      const meaningful = u > 0 && px > 14
      uncert.hidden = !meaningful
      if (meaningful) {
        uncert.style.width = `${px.toFixed(0)}px`
        uncert.style.height = `${px.toFixed(0)}px`
        uncert.style.transform = blip.style.transform
      }
    }
  } else {
    blip.hidden = true
    if (uncert) uncert.hidden = true
  }

  // North marker: only meaningful when the scope is heading-up (it rotates as
  // the phone turns); in north-up fallback it sits at the top.
  if (north) {
    const northAngle = heading === null ? 0 : -heading
    north.style.transform = `rotate(${northAngle.toFixed(1)}deg)`
  }

  if (distance) {
    distance.textContent = g.state === 'arrived'
      ? 'HERE'
      : g.distanceMetres === null ? '—' : s.host.fmtDistance(g.distanceMetres).replace('~', '')
  }
  if (status) status.textContent = statusCopy(g, s.host.fmtDistance)
}

/** The distinct "target moved" interrupt: a rising two-note sweep, a short
 *  triple haptic, and a visual flash — then the normal cadence resumes. */
function movedPulse(s: RadarSession): void {
  // Sound/vibration only when JS owns the cue — the native guide plays its
  // own moved interrupt from the same pure rule (no double pulse).
  if (!s.nativeGuide) {
    if (!s.muted && s.audio) {
      beep(s.audio, 660, 0, 0.09)
      beep(s.audio, 1320, 0.11, 0.09)
    }
    try { navigator.vibrate?.([40, 40, 40]) } catch { /* no haptics */ }
  }
  const blip = s.el.querySelector('#radar-blip') as HTMLElement | null
  if (blip) {
    blip.classList.remove('moved')
    void blip.offsetWidth
    blip.classList.add('moved')
  }
}

// ── The beeper: cue → sound + haptics ────────────────────────────────────────

/** Self-scheduling loop reading the CURRENT cue each cycle, so a cadence change
 *  takes effect on the next burst without restarting anything. Silent cues just
 *  idle-poll cheaply. Muting kills sound only — haptics keep the bearing usable
 *  in a loud place or with the phone away (goal: haptics mirror the signal). */
function beepLoop(s: RadarSession): void {
  if (s.closed) return
  const cue = s.cue
  // With the native guide running it is the ONE sound/haptic source (it keeps
  // going when the screen locks; two sources would double-beep in the hand).
  if (cue.pattern !== 'silent' && !s.nativeGuide) {
    if (!s.muted && s.audio) {
      const bursts = cue.pattern === 'triple' ? 3 : cue.pattern === 'double' ? 2 : 1
      for (let i = 0; i < bursts; i++) beep(s.audio, cue.toneHz, i * 0.15, 0.07)
    }
    try { navigator.vibrate?.(cue.vibrateMs) } catch { /* no haptics */ }
  }
  s.beepTimer = window.setTimeout(() => beepLoop(s), cue.pattern === 'silent' ? 300 : cue.periodMs)
}

/** One tracker blip-tone: triangle wave, fast attack, short decay. */
function beep(ctx: AudioContext, hz: number, delaySec: number, durSec: number): void {
  try {
    const t = ctx.currentTime + delaySec
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = hz
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durSec)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + durSec + 0.02)
  } catch { /* audio unavailable — haptics still run */ }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

const escText = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

function mountRadar(host: RadarHost): HTMLElement {
  document.getElementById('radar-shell')?.remove()
  const tmp = document.createElement('div')
  tmp.innerHTML = `<div class="radar-shell" id="radar-shell" role="dialog" aria-modal="true" aria-label="Radar — finding ${escText(host.targetName())}">
    <div class="radar-head">
      <div class="radar-title">Finding <strong>${escText(host.targetName())}</strong></div>
      <div class="radar-fresh" id="radar-fresh">…</div>
    </div>
    <div class="radar-scope" id="radar-scope">
      <div class="radar-ring r1"></div>
      <div class="radar-ring r2"></div>
      <div class="radar-ring r3"></div>
      <div class="radar-cross"></div>
      <div class="radar-sweep"></div>
      <div class="radar-north" id="radar-north"><span>N</span></div>
      <div class="radar-uncert" id="radar-uncert" hidden></div>
      <div class="radar-blip" id="radar-blip" hidden></div>
      <div class="radar-range" id="radar-range"></div>
      <div class="radar-self"></div>
    </div>
    <div class="radar-distance" id="radar-distance">—</div>
    <div class="radar-status" id="radar-status"></div>
    <div class="radar-controls">
      <button class="radar-sound" id="radar-sound" aria-pressed="false">🔊 Sound on</button>
      <button class="radar-stop" id="radar-stop">Stop</button>
    </div>
  </div>`
  const el = tmp.firstElementChild as HTMLElement
  host.layer.appendChild(el)
  el.querySelector('#radar-stop')?.addEventListener('click', () => closeRadar())
  el.querySelector('#radar-sound')?.addEventListener('click', (e) => {
    const s = session
    if (!s) return
    s.muted = !s.muted
    if (s.nativeGuide) void nativeGuideApi().then((m) => m?.setRadarGuideMuted(s.muted))
    const btn = e.currentTarget as HTMLElement
    btn.textContent = s.muted ? '🔇 Sound off' : '🔊 Sound on'
    btn.setAttribute('aria-pressed', String(s.muted))
  })
  return el
}
