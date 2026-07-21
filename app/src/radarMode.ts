// Radar mode — the foreground Alien-inspired motion tracker, v2. One selected
// person or pin, one dominant scope, one obvious Stop. The controller owns the
// DOM overlay, the compass/orientation listener, the Web Audio beeper (now with
// stereo pan), the vibration mirror (now with a signed turn vocabulary), the
// speech-synthesis voice channel and the screen wake lock; every DECISION
// (heading arbitration, mode, guidance, cue, movement, honesty rules) comes
// from the pure library module (@forgesworn/flock/radar) so it stays tested.
//
// Privacy: this consumes ONLY the already-disclosed beacon the host hands it —
// it never publishes, never changes anyone's precision or cadence, and a
// coarse/stale/withheld target degrades the cue instead of pointing precisely
// (docs/plans/2026-07-09-radar-navigation-goal.md, extended by …-v2). v2 changes
// presentation only: three modes (VECTOR/SEEK/HOMING), richer honesty-gated
// cues, and voice — never precision or acquisition. Foreground here; the locked-
// phone parity lives in the native RadarGuideService, driven by the same core.

import {
  radarGuidance,
  cueFor,
  targetMoved,
  courseFromFixes,
  classifyFreshness,
  resolveHeading,
  smoothHeadingDeg,
  smoothClosingRate,
  selectMode,
  crossedMilestone,
  voiceLine,
  speakableDistanceMetres,
  haversineMetres,
  bleProximityFromRssi,
  bleAssistUsable,
  RADAR,
  type RadarCue,
  type RadarGuidance,
  type RadarMode,
  type HeadingStatus,
  type TimedPosition,
  type BleProximity,
} from '@forgesworn/flock'
import { headingFromOrientation, blipXY, niceRange, freshnessLabel, statusCopy, arrowAngleDeg, modeChipLabel } from './radarView'
import { VOICE_CLIP_IDS, voiceClipSeq } from './voiceClips'
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
  /** The target member's mesh peer id (their pubkey — the mesh's `selfId` IS
   *  the member's pk, learned via the in-room frame exchange), for BLE RSSI
   *  attribution (radar-v2 Phase 3). Null/omitted for a pin — pins carry no
   *  radio, so radar never samples for one. */
  meshPeerId?: string | null
  targetName: () => string
  /** The selected member's latest already-permitted disclosure, or null. */
  getTarget: () => RadarTargetFeed | null
  /** My own latest fix (purely local consumption), or null. `accuracy` gates the
   *  v2 my-fix honesty rules; `heading`/`speed` feed the heading engine + modes. */
  getMyFix: () => { lat: number; lon: number; at: number; accuracy?: number | null; heading?: number | null; speed?: number | null } | null
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
/** Circular-EMA smoothing alpha per mode: quick in a vehicle, damped in the
 *  endgame so the pointer doesn't twitch on GPS noise. */
const HEADING_ALPHA: Record<RadarMode, number> = { vector: 0.5, seek: 0.3, homing: 0.15 }
/** Closing-rate EMA alpha (warmer/colder). */
const RATE_ALPHA = 0.3
/** No two spoken lines closer than this, arrival excepted. */
const VOICE_MIN_INTERVAL_MS = RADAR.voiceMinIntervalSec * 1000
/** A sustained relative-bearing swing beyond this (VECTOR) re-announces the side. */
const BEARING_CHANGE_DEGREES = 30
/** BLE RSSI sampling interval — battery-conscious, plenty for a median window.
 *  The window's age/depth caps (12 s / 10 samples) live in native/ble.ts's
 *  armRssiWindow, alongside the sampling it starts. */
const BLE_SAMPLE_INTERVAL_MS = 2000

const SILENT_CUE: RadarCue = { pattern: 'silent', periodMs: 0, toneHz: 0, vibrateMs: [], pan: 0, sign: null, trend: null }

interface RadarSession {
  host: RadarHost
  el: HTMLElement
  stopLocalFix: () => void
  tickTimer: number
  beepTimer: number
  signTimer: number
  removeOrientation: () => void
  removeVisibility: () => void
  audio: AudioContext | null
  muted: boolean
  /** Voice (TTS) channel on. On by default — VECTOR leads with it; on foot only
   *  mode/degradation/arrival lines speak, so it stays sparse. */
  voice: boolean
  /** A stationary waypoint (a dropped pin) — the native guide must not age it to
   *  "stale" while the screen is locked. */
  evergreen: boolean
  cue: RadarCue
  compassHeading: number | null
  /** The platform's compass-accuracy verdict (best-effort on web; the native
   *  guide has the real onAccuracyChanged signal). */
  compassUsable: boolean
  lastFixes: TimedPosition[]
  lastObservation: { position: { lat: number; lon: number }; uncertaintyMetres: number; timestamp: number } | null
  lastState: RadarGuidance['state'] | null
  /** The scope's current full-scale range — niceRange's hysteresis memory. */
  rangeMetres: number | null
  // ── v2 heading engine + mode machine state ──
  mode: RadarMode
  modeOverride: RadarMode | null
  smoothedHeading: number | null
  headingStatus: HeadingStatus
  lastHeadingStatus: HeadingStatus
  lastAnnouncedMode: RadarMode | null
  fastSinceMs: number | null
  slowSinceMs: number | null
  // ── v2 warmer/colder + voice cadence state ──
  closingRate: number | null
  lastDistance: number | null
  lastDistanceAtMs: number | null
  voiceLastAtMs: number
  lastVoiceBearing: number | null
  /** When the minute-cadence range/clock line last spoke (v2.1). */
  lastPeriodicAtMs: number
  /** A genuine target move landed and its spoken interrupt is still owed. */
  movedAnnouncePending: boolean
  /** When the native compass mirror last delivered (0 = never): while it is
   *  fresh it owns s.compassHeading and the DOM orientation event stands down. */
  nativeHeadingAtMs: number
  /** Pre-baked TTS clips decoded for on-device, offline playback (radar-v2). */
  voiceBuffers: Map<string, AudioBuffer>
  wakeLock: { release: () => Promise<void> } | null
  /** Native locked-phone guide running (Android shell): it owns ALL audio +
   *  haptics + voice for the session so the two sources never double-fire; JS
   *  keeps the visuals. */
  nativeGuide: boolean
  nativeCheck: number
  // ── Phase 3: BLE RSSI proximity assist ──
  /** The live peer-filtered window (native/ble.ts), or null when not armed —
   *  re-evaluated every tick against the live disclosure (armed only for a
   *  MEMBER target whose current share is not coarse; see syncBleArm). */
  bleWindow: { values: () => number[]; stop: () => void } | null
  /** Guards overlapping arm/disarm calls (both are async). */
  bleArming: boolean
  bleProximity: BleProximity
  /** mode === 'homing' AND the band is honestly usable AND immediate — the
   *  combined "very close, by radio" claim the status line and voice share. */
  bleClose: boolean
  lastBleClose: boolean
  closed: boolean
}

/** A lazy, native-shell-only module loader: null outside the shell or on any
 *  import failure (older shell). Both bridges below share this shape. */
function nativeModule<T>(loader: () => Promise<T>): () => Promise<T | null> {
  return async () => {
    if (!isNativeShell()) return null
    try { return await loader() } catch { return null }
  }
}

/** The native guide bridge, when the shell provides it. */
const nativeGuideApi = nativeModule(() => import('../../native/radarGuide'))
/** The mesh-BLE bridge, when the shell provides it — radar's own RSSI window
 *  is a THIN consumer of the mesh the app already owns (app.ts syncBle); it
 *  never starts/stops the mesh itself, only the opt-in RSSI sampler layered
 *  on top of it. */
const bleApi = nativeModule(() => import('../../native/ble'))

let session: RadarSession | null = null

export function isRadarOpen(): boolean {
  return session !== null
}

/** Stop everything NOW — audio, haptics, voice, sensors, DOM. Safe to call twice. */
export function closeRadar(): void {
  const s = session
  if (!s || s.closed) return
  s.closed = true
  session = null
  window.clearInterval(s.tickTimer)
  window.clearTimeout(s.beepTimer)
  window.clearTimeout(s.signTimer)
  s.removeOrientation()
  s.removeVisibility()
  s.stopLocalFix()
  try { navigator.vibrate?.(0) } catch { /* no haptics */ }
  try { window.speechSynthesis?.cancel() } catch { /* no voice */ }
  void s.wakeLock?.release().catch(() => { /* already released */ })
  void s.audio?.close().catch(() => { /* already closed */ })
  if (s.nativeGuide) void nativeGuideApi().then((m) => m?.stopRadarGuide())
  // BLE RSSI sampling: always stop on close (the only consumer today — no
  // arm-tracking needed to avoid fighting another feature).
  s.bleWindow?.stop()
  s.bleWindow = null
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

export function openRadar(host: RadarHost, opts: { evergreen?: boolean } = {}): void {
  closeRadar()
  const el = mountRadar(host)
  session = {
    host,
    el,
    stopLocalFix: host.startLocalFix(),
    tickTimer: 0,
    beepTimer: 0,
    signTimer: 0,
    removeOrientation: () => { /* replaced below */ },
    removeVisibility: () => { /* replaced below */ },
    audio: null,
    muted: false,
    voice: true,
    evergreen: !!opts.evergreen,
    cue: SILENT_CUE,
    compassHeading: null,
    compassUsable: true,
    lastFixes: [],
    lastObservation: null,
    lastState: null,
    rangeMetres: null,
    mode: 'seek',
    modeOverride: null,
    smoothedHeading: null,
    headingStatus: 'none',
    lastHeadingStatus: 'none',
    lastAnnouncedMode: null,
    fastSinceMs: null,
    slowSinceMs: null,
    closingRate: null,
    lastDistance: null,
    lastDistanceAtMs: null,
    voiceLastAtMs: 0,
    lastVoiceBearing: null,
    lastPeriodicAtMs: 0,
    movedAnnouncePending: false,
    nativeHeadingAtMs: 0,
    voiceBuffers: new Map(),
    wakeLock: null,
    nativeGuide: false,
    nativeCheck: 0,
    bleWindow: null,
    bleArming: false,
    bleProximity: null,
    bleClose: false,
    lastBleClose: false,
    closed: false,
  }
  const s = session
  // The open tap is the user gesture audio needs — create the context here.
  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    const C = Ctx.AudioContext ?? Ctx.webkitAudioContext
    if (C) s.audio = new C()
  } catch { /* no audio — haptics + visuals still work */ }
  void preloadVoiceClips(s)
  // Keep the screen awake while the scope is up: today it could sleep mid-drive
  // and freeze the visuals (radar-v2 VECTOR). Best-effort; haptics/voice carry
  // the locked case natively.
  void acquireWakeLock(s)
  // Android shell: hand audio/haptics/voice to the native guide so guidance keeps
  // going when the screen locks (the WebView's timers don't). JS keeps the
  // visuals; the pure core is the same on both sides (golden vectors).
  void nativeGuideApi().then((m) => {
    if (!m || s.closed) return
    const t = host.getTarget()
    void m.startRadarGuide(t ? { lat: t.lat, lon: t.lon, uncertaintyMetres: t.uncertaintyMetres, timestampMs: t.timestamp * 1000, evergreen: s.evergreen, meshPeerId: host.meshPeerId ?? null } : null, s.muted, s.voice)
      .then(() => { if (s.closed) void m.stopRadarGuide(); else s.nativeGuide = true })
  })
  void startOrientation(s)
  const onVis = (): void => { if (!s.closed && document.visibilityState === 'visible') void acquireWakeLock(s) }
  document.addEventListener('visibilitychange', onVis)
  s.removeVisibility = () => document.removeEventListener('visibilitychange', onVis)
  tick(s)
  s.tickTimer = window.setInterval(() => tick(s), TICK_MS)
  beepLoop(s)
}

/** Hold a screen wake lock while radar is open (re-acquired on tab re-show). */
async function acquireWakeLock(s: RadarSession): Promise<void> {
  if (s.wakeLock) return
  try {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock
    if (!wl) return
    const sentinel = await wl.request('screen')
    if (s.closed) { void sentinel.release().catch(() => { /* gone */ }); return }
    s.wakeLock = sentinel
    // A sentinel is auto-released when the tab hides; forget it so onVis re-asks.
    ;(sentinel as unknown as { addEventListener?: (t: string, cb: () => void) => void })
      .addEventListener?.('release', () => { if (s.wakeLock === sentinel) s.wakeLock = null })
  } catch { /* wake lock unavailable — the visuals just may sleep */ }
}

// ── BLE proximity (radar-v2 Phase 3) ───────────────────────────────────────
// A THIN consumer: native/ble.ts owns starting/stopping sampling and the
// peer-filtered rolling window (armRssiWindow) — this only decides WHEN to
// arm/disarm against the live disclosure and turns the window into a band
// every tick. Attribution comes from the plugin (an RSSI sample is only ever
// tagged with a mesh peer id already bound to that member by an authenticated
// frame exchange — never a raw, unattributed advert), so armRssiWindow's peer
// filter is exactly the "identified GATT link" rule, not an extra trust call.

/** Re-evaluate arm/disarm against the LIVE disclosure every tick — never start
 *  sampling for a pin (no `meshPeerId`) or a deliberately coarse share, and
 *  disarm immediately if a share that was precise becomes coarse mid-session. */
function syncBleArm(s: RadarSession, target: { uncertaintyMetres: number } | null): void {
  const wantArmed = !!s.host.meshPeerId && target !== null && target.uncertaintyMetres <= RADAR.coarseUncertaintyMetres
  if (wantArmed === !!s.bleWindow || s.bleArming) return
  s.bleArming = true
  if (!wantArmed) s.bleProximity = null
  const peer = wantArmed ? (s.host.meshPeerId as string) : null
  void bleApi()
    .then((ble) => ble?.syncRssiWindow(s.bleWindow, peer, { intervalMs: BLE_SAMPLE_INTERVAL_MS, isClosed: () => s.closed }) ?? null)
    .then((w) => { s.bleWindow = w })
    .finally(() => { s.bleArming = false })
}

/** Re-derive the band from the live window every tick — an armed window ages
 *  its own samples, so a quiet mesh (dropped, out of range) decays to null
 *  within one window's width without any extra bookkeeping here. */
function updateBleWindow(s: RadarSession): void {
  s.bleProximity = s.bleWindow ? bleProximityFromRssi(s.bleWindow.values()) : null
}

// ── Sensors ──────────────────────────────────────────────────────────────────

const screenAngle = (): number => (typeof screen !== 'undefined' && screen.orientation?.angle) || 0

/** How long a native compass sample owns the heading before the DOM event may
 *  speak again (native mirrors at ~150 ms while the guide service runs). */
const NATIVE_HEADING_FRESH_MS = 2000

/** Compass heading. In the native shell the PRIMARY source is the guide
 *  service's rotation-vector compass, mirrored over the bridge — the WebView's
 *  own deviceorientation is not earth-referenced there, which left the scope
 *  north-up-frozen in the field (2026-07-21). DeviceOrientation stays wired as
 *  the web/PWA path and the fallback if the mirror goes quiet. iOS 13+ needs a
 *  permission call from a user gesture — the open tap qualifies. A
 *  denied/missing compass simply leaves heading null: the radar honestly falls
 *  back to course over ground. */
async function startOrientation(s: RadarSession): Promise<void> {
  let removeNative: () => void = () => { /* not subscribed */ }
  if (isNativeShell()) {
    const m = await nativeGuideApi()
    if (s.closed) return
    if (m) {
      removeNative = m.onRadarHeading((deg, usable) => {
        // The mirror is device-frame; compensate a rotated screen like the DOM
        // path does so heading-up stays honest in landscape.
        s.compassHeading = (((deg + screenAngle()) % 360) + 360) % 360
        s.compassUsable = usable
        s.nativeHeadingAtMs = Date.now()
      })
    }
  }
  const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
  if (typeof D?.requestPermission === 'function') {
    try {
      if (await D.requestPermission() !== 'granted') { s.removeOrientation = removeNative; return }
    } catch { s.removeOrientation = removeNative; return }
  }
  if (s.closed) { removeNative(); return }
  const onEvent = (e: DeviceOrientationEvent): void => {
    // While the native mirror is fresh it owns the heading channel.
    if (Date.now() - s.nativeHeadingAtMs < NATIVE_HEADING_FRESH_MS) return
    const webkit = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading
    s.compassHeading = headingFromOrientation(
      { alpha: e.alpha, absolute: e.absolute, webkitCompassHeading: webkit },
      screenAngle(),
    )
    // iOS surfaces a compass-accuracy in degrees (−1 = unavailable); a very
    // loose accuracy means the magnetometer needs calibrating — treat as
    // unusable so the heading engine leans on course over ground.
    const acc = (e as unknown as { webkitCompassAccuracy?: number }).webkitCompassAccuracy
    s.compassUsable = typeof acc === 'number' ? acc >= 0 && acc <= 30 : s.compassHeading !== null
  }
  // Prefer the earth-referenced event where the platform provides it.
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
  window.addEventListener(type, onEvent as EventListener)
  s.removeOrientation = () => {
    removeNative()
    window.removeEventListener(type, onEvent as EventListener)
  }
}

/** GPS course over ground: the Doppler `coords.heading` when GENUINELY moving
 *  (far better than a two-fix derivation), else the two-fix fallback ("walk a
 *  few steps"). v2.1 trust floor: a heading on a fix slower than
 *  `courseMinSpeedMps` — or an old fix — is a stationary artefact; consuming it
 *  froze the pointer at the last walking direction when the phone was set down
 *  (field test 2026-07-21). */
function gpsCourse(s: RadarSession, my: { at: number; heading?: number | null; speed?: number | null } | null): number | null {
  const nowSec = Math.floor(Date.now() / 1000)
  if (my && typeof my.heading === 'number' && Number.isFinite(my.heading) &&
      (my.speed ?? 0) >= RADAR.courseMinSpeedMps &&
      nowSec - my.at <= COURSE_MAX_AGE_SEC) return my.heading
  const prev = s.lastFixes[s.lastFixes.length - 2]
  const cur = s.lastFixes[s.lastFixes.length - 1]
  if (!prev || !cur) return null
  if (nowSec - cur.atSec > COURSE_MAX_AGE_SEC) return null
  return courseFromFixes(prev, cur)
}

/** Ground speed: `coords.speed` when the platform gives it, else derived from my
 *  two most recent fixes. Null when neither is available (→ heading engine and
 *  mode machine treat me as stationary). */
function gpsSpeed(s: RadarSession, my: { speed?: number | null } | null): number | null {
  if (my && typeof my.speed === 'number' && Number.isFinite(my.speed)) return my.speed
  const prev = s.lastFixes[s.lastFixes.length - 2]
  const cur = s.lastFixes[s.lastFixes.length - 1]
  if (!prev || !cur) return null
  const dt = cur.atSec - prev.atSec
  if (dt <= 0) return null
  return haversineMetres(prev.position, cur.position) / dt
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
      s.movedAnnouncePending = true // the spoken twin rides the next tick's guidance
    }
    if (s.nativeGuide) {
      void nativeGuideApi().then((m) =>
        m?.updateRadarTarget({ lat: t.lat, lon: t.lon, uncertaintyMetres: t.uncertaintyMetres, timestampMs: t.timestamp * 1000, meshPeerId: s.host.meshPeerId ?? null }))
    }
  }
  s.lastObservation = { position: { lat: t.lat, lon: t.lon }, uncertaintyMetres: t.uncertaintyMetres, timestamp: t.timestamp }
}

function tick(s: RadarSession): void {
  if (s.closed) return
  const nowMs = Date.now()
  const nowSec = Math.floor(nowMs / 1000)
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

  // BLE RSSI proximity (Phase 3): re-check arm/disarm against the LIVE
  // disclosure, then age/derive the window — every tick, mirroring how the
  // heading/mode machinery below re-reads live sensor state each cycle.
  syncBleArm(s, target)
  updateBleWindow(s)

  // The native guide's notification has its own Stop — if the user ended the
  // session from the lock screen, the reopened tracker must not linger.
  if (s.nativeGuide && !document.hidden && ++s.nativeCheck % 4 === 0) {
    void nativeGuideApi().then((m) => m?.isRadarGuideActive().then((active) => {
      if (!active && session === s && !s.closed) closeRadar()
    }))
  }

  // Heading engine (radar-v2 Fault 1): arbitrate compass vs course by speed.
  const courseDeg = gpsCourse(s, my)
  const speedMps = gpsSpeed(s, my)
  const solution = resolveHeading({
    compassDeg: s.compassHeading,
    compassUsable: s.compassUsable,
    courseDeg,
    speedMps,
  })
  s.headingStatus = solution.status

  // Prelim distance for the mode machine (radarGuidance recomputes it cheaply).
  const prelimDistance = my && target ? haversineMetres({ lat: my.lat, lon: my.lon }, target.position) : null
  const { fastForSec, slowForSec } = updateSpeedDurations(s, speedMps, nowMs)
  const mode = s.modeOverride ?? selectMode({
    prevMode: s.mode,
    distanceMetres: prelimDistance,
    speedMps,
    fastForSec,
    slowForSec,
    uncertaintyMetres: target?.uncertaintyMetres ?? null,
    bleProximity: s.bleProximity,
  })
  s.mode = mode

  // Smooth the resolved heading with the per-mode alpha (fast in VECTOR, damped
  // in HOMING). A dropped source resets the smoother so it never lingers.
  if (solution.headingDeg === null) {
    s.smoothedHeading = null
  } else {
    s.smoothedHeading = smoothHeadingDeg(s.smoothedHeading, solution.headingDeg, HEADING_ALPHA[mode])
  }
  const heading = s.smoothedHeading

  const g = radarGuidance({
    me: my ? { lat: my.lat, lon: my.lon } : null,
    headingDeg: heading,
    target,
    myAccuracyMetres: my?.accuracy ?? null,
  })

  // Warmer/colder: smooth d(distance)/dt for the HOMING trend note.
  if (g.distanceMetres !== null && s.lastDistance !== null && s.lastDistanceAtMs !== null) {
    const dt = (nowMs - s.lastDistanceAtMs) / 1000
    s.closingRate = smoothClosingRate(s.closingRate, s.lastDistance, g.distanceMetres, dt, RATE_ALPHA)
  }

  // Arrival: silence immediately, one short confirmation haptic (goal §4).
  // With the native guide running, IT owns the haptic (same rule, same core).
  if (g.state === 'arrived' && s.lastState !== 'arrived' && !s.nativeGuide) {
    try { navigator.vibrate?.(cueFor(g).vibrateMs) } catch { /* no haptics */ }
  }

  // The combined "very close, by radio" claim: HOMING + an honestly-usable
  // (non-coarse, GPS-near) immediate band. Shared by the status line and the
  // voice transition below — one source of truth for the honesty gate.
  s.bleClose = mode === 'homing' && s.bleProximity === 'immediate' && bleAssistUsable(g, s.bleProximity)

  announceVoice(s, g, mode, nowMs)

  s.lastState = g.state
  s.lastHeadingStatus = s.headingStatus
  s.lastAnnouncedMode = mode
  s.lastBleClose = s.bleClose
  if (g.distanceMetres !== null) { s.lastDistance = g.distanceMetres; s.lastDistanceAtMs = nowMs }
  s.cue = cueFor(g, { mode, closingRateMps: s.closingRate, bleProximity: s.bleProximity })
  patchScope(s, g, target?.ageSeconds ?? null, heading, mode)
}

/** Track how long ground speed has held above/below the VECTOR thresholds, for
 *  the mode machine's sustained-speed hysteresis. */
function updateSpeedDurations(s: RadarSession, speedMps: number | null, nowMs: number): { fastForSec: number; slowForSec: number } {
  const sp = speedMps ?? 0
  if (sp >= RADAR.vectorEnterSpeedMps) { if (s.fastSinceMs === null) s.fastSinceMs = nowMs } else s.fastSinceMs = null
  if (sp < RADAR.vectorExitSpeedMps) { if (s.slowSinceMs === null) s.slowSinceMs = nowMs } else s.slowSinceMs = null
  return {
    fastForSec: s.fastSinceMs === null ? 0 : (nowMs - s.fastSinceMs) / 1000,
    slowForSec: s.slowSinceMs === null ? 0 : (nowMs - s.slowSinceMs) / 1000,
  }
}

// ── Voice: pre-baked clips (offline) with on-device TTS fallback ──────────────

/** Fetch + decode the whole clip vocabulary into AudioBuffers for gapless,
 *  network-free playback. Best-effort — a failed fetch just leaves that clip
 *  absent, and playback falls back to speechSynthesis for anything missing. */
async function preloadVoiceClips(s: RadarSession): Promise<void> {
  const ctx = s.audio
  if (!ctx) return
  await Promise.all(VOICE_CLIP_IDS.map(async (id) => {
    try {
      const res = await fetch(`voice/${id}.mp3`)
      if (!res.ok) return
      const buf = await ctx.decodeAudioData(await res.arrayBuffer())
      if (!s.closed) s.voiceBuffers.set(id, buf)
    } catch { /* clip absent — TTS fallback covers it */ }
  }))
}

/** Play a voice event: the pre-baked clip sequence when every clip is loaded,
 *  else on-device speechSynthesis of `fallbackText`. Gated on the Voice toggle
 *  and (unless urgent) the rate limit; silent while the native guide owns audio.
 *  Returns whether a line was actually spoken (the periodic cadence stamps its
 *  clock only on a real utterance). */
function playVoice(s: RadarSession, clipIds: string[], fallbackText: string, nowMs: number, urgent = false): boolean {
  if (s.nativeGuide || !s.voice) return false
  if (clipIds.length === 0 && !fallbackText) return false
  if (!urgent && nowMs - s.voiceLastAtMs < VOICE_MIN_INTERVAL_MS) return false
  s.voiceLastAtMs = nowMs
  const ctx = s.audio
  const haveAll = clipIds.length > 0 && ctx !== null && clipIds.every((id) => s.voiceBuffers.has(id))
  if (haveAll && ctx) {
    let t = ctx.currentTime + 0.02
    for (const id of clipIds) {
      const buf = s.voiceBuffers.get(id)
      if (!buf) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.start(t)
      t += buf.duration + 0.06 // a natural beat between clips
    }
    return true
  }
  // Fallback: on-device TTS (robotic but offline + immediate).
  try {
    const synth = window.speechSynthesis
    if (!synth || !fallbackText) return false
    synth.cancel() // never queue a stale line behind a fresh one
    synth.speak(new SpeechSynthesisUtterance(fallbackText))
    return true
  } catch { /* no speech synthesis — earcons + haptics carry it */ }
  return false
}

/** States that get the minute-cadence range callout: live pointing, a
 *  compassless fallback, and a coarse share (the range is still honest). */
const PERIODIC_STATES: RadarGuidance['state'][] = ['point', 'no-heading', 'coarse']

/** The voice policy: mode changes, degradations, compass distrust and arrival
 *  everywhere; distance milestones + sustained bearing swings lead in VECTOR;
 *  and (v2.1) a minute-cadence "<range>, at your <clock>" line in EVERY mode —
 *  the by-ear glance the 2026-07-21 field test asked for. */
function announceVoice(s: RadarSession, g: RadarGuidance, mode: RadarMode, nowMs: number): void {
  if (s.nativeGuide || !s.voice) return

  // Arrival wins and bypasses the rate limit.
  if (g.state === 'arrived' && s.lastState !== 'arrived') {
    playVoice(s, voiceClipSeq({ kind: 'arrived' }), voiceLine({ kind: 'arrived' }, g, s.host.fmtDistance), nowMs, true)
    return
  }
  // Mode change earns a distinct line.
  if (mode !== s.lastAnnouncedMode && s.lastAnnouncedMode !== null) {
    playVoice(s, voiceClipSeq({ kind: 'mode', mode }), voiceLine({ kind: 'mode', mode }, g, s.host.fmtDistance), nowMs)
    return
  }
  // The compass was just overruled by course over ground.
  if (s.headingStatus === 'compass-unreliable' && s.lastHeadingStatus !== 'compass-unreliable') {
    playVoice(s, voiceClipSeq({ kind: 'compass-unreliable' }), voiceLine({ kind: 'compass-unreliable' }, g, s.host.fmtDistance), nowMs)
    return
  }
  // A fresh degradation (stale / coarse / lost fix) states itself plainly.
  const degraded = g.state === 'stale' || g.state === 'coarse' || g.state === 'no-fix' || g.state === 'unavailable'
  const wasDegraded = s.lastState === 'stale' || s.lastState === 'coarse' || s.lastState === 'no-fix' || s.lastState === 'unavailable'
  if (degraded && !wasDegraded) {
    playVoice(s, voiceClipSeq({ kind: 'degraded', state: g.state }), voiceLine({ kind: 'degraded', state: g.state }, g, s.host.fmtDistance), nowMs)
    return
  }

  // BLE proximity (Phase 3): the band just became honestly "very close" while
  // homing — radio confirming a story GPS alone can't finish indoors. Rate-
  // limited like every other line; never a distance, never a direction.
  if (s.bleClose && !s.lastBleClose) {
    playVoice(s, voiceClipSeq({ kind: 'ble-close' }), voiceLine({ kind: 'ble-close' }, g, s.host.fmtDistance), nowMs)
    return
  }

  // A genuine target move (v2.1): the spoken twin of the moved pulse — beacons
  // are sparse (cell-gated, >=45 s), so each one landing must be unmissable.
  if (s.movedAnnouncePending) {
    s.movedAnnouncePending = false
    if (g.distanceMetres !== null) {
      const rounded = speakableDistanceMetres(g.distanceMetres)
      if (playVoice(s,
        voiceClipSeq({ kind: 'moved', roundedMetres: rounded, relativeBearingDeg: g.bearingUsable ? g.relativeBearingDeg : null }),
        voiceLine({ kind: 'moved', distanceMetres: rounded }, g, s.host.fmtDistance), nowMs)) {
        s.lastPeriodicAtMs = nowMs // a moved line is this minute's range callout too
      }
      return
    }
  }

  // VECTOR: milestone crossings + sustained bearing swings lead the channel.
  if (mode === 'vector' && g.bearingUsable && g.distanceMetres !== null) {
    const milestone = crossedMilestone(s.lastDistance, g.distanceMetres)
    if (milestone !== null) {
      if (playVoice(s,
        voiceClipSeq({ kind: 'milestone', milestoneMetres: milestone, relativeBearingDeg: g.relativeBearingDeg }),
        voiceLine({ kind: 'milestone', distanceMetres: milestone }, g, s.host.fmtDistance), nowMs)) {
        s.lastPeriodicAtMs = nowMs // a milestone line counts as this minute's range callout
      }
      s.lastVoiceBearing = g.relativeBearingDeg
      return
    }
    if (g.relativeBearingDeg !== null && (s.lastVoiceBearing === null || Math.abs(g.relativeBearingDeg - s.lastVoiceBearing) > BEARING_CHANGE_DEGREES)) {
      playVoice(s, voiceClipSeq({ kind: 'bearing-change', relativeBearingDeg: g.relativeBearingDeg }),
        voiceLine({ kind: 'bearing-change' }, g, s.host.fmtDistance), nowMs)
      s.lastVoiceBearing = g.relativeBearingDeg
      return
    }
  }

  // The minute-cadence status line (v2.1): rounded range + clock-face
  // direction; range-only when the bearing isn't honest. Every mode.
  if (g.distanceMetres !== null && PERIODIC_STATES.includes(g.state) &&
      nowMs - s.lastPeriodicAtMs >= RADAR.periodicVoiceSec * 1000) {
    const rounded = speakableDistanceMetres(g.distanceMetres)
    if (playVoice(s,
      voiceClipSeq({ kind: 'periodic', roundedMetres: rounded, relativeBearingDeg: g.bearingUsable ? g.relativeBearingDeg : null }),
      voiceLine({ kind: 'periodic', distanceMetres: rounded }, g, s.host.fmtDistance), nowMs)) {
      s.lastPeriodicAtMs = nowMs
    }
  }
}

function patchScope(s: RadarSession, g: RadarGuidance, ageSeconds: number | null, heading: number | null, mode: RadarMode): void {
  const q = (id: string): HTMLElement | null => s.el.querySelector(`#${id}`)
  const scope = q('radar-scope')
  const blip = q('radar-blip')
  const uncert = q('radar-uncert')
  const north = q('radar-north')
  const arrow = q('radar-arrow')
  const fresh = q('radar-fresh')
  const distance = q('radar-distance')
  const status = q('radar-status')
  const range = q('radar-range')
  const modeChip = q('radar-mode')
  const maps = q('radar-maps') as HTMLButtonElement | null
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
  scope.dataset.mode = mode

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

  // The big directional arrow (VECTOR/HOMING glanceable face). Shown only while
  // the bearing is honest — in HOMING inside GPS-fiction range it's dropped and
  // the status line switches to warmer/colder.
  if (arrow) {
    const a = arrowAngleDeg(g)
    const show = a !== null && (mode === 'vector' || mode === 'homing')
    arrow.hidden = !show
    if (show) arrow.style.transform = `rotate(${(a as number).toFixed(1)}deg)`
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
  if (status) status.textContent = statusCopy(g, s.host.fmtDistance, { headingStatus: s.headingStatus, mode, trend: s.cue.trend, bleClose: s.bleClose })
  if (modeChip) modeChip.textContent = modeChipLabel(mode, s.modeOverride)
  // Only in VECTOR, only in the native shell (a web tab has no maps chooser
  // intent), and only once there is a real position to hand off to.
  if (maps) maps.hidden = !(mode === 'vector' && isNativeShell() && !!s.lastObservation)
}

/** The distinct "target moved" interrupt: a rising two-note sweep, a short
 *  triple haptic, and a visual flash — then the normal cadence resumes. */
function movedPulse(s: RadarSession): void {
  // Sound/vibration only when JS owns the cue — the native guide plays its
  // own moved interrupt from the same pure rule (no double pulse).
  if (!s.nativeGuide) {
    if (!s.muted && s.audio) {
      beep(s.audio, 660, 0, 0.09, 0)
      beep(s.audio, 1320, 0.11, 0.09, 0)
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

/** Two short taps = turn right, one long buzz = turn left — the signed haptic
 *  vocabulary, played BETWEEN cadence bursts when off-beam (eyes/ears-free). */
const SIGN_HAPTIC: Record<'left' | 'right', number[]> = { right: [30, 60, 30], left: [180] }

/** Self-scheduling loop reading the CURRENT cue each cycle, so a cadence change
 *  takes effect on the next burst without restarting anything. Silent cues just
 *  idle-poll cheaply. Muting kills SOUND only — haptics (incl. the turn sign)
 *  keep the bearing usable in a loud place or with the phone away. */
function beepLoop(s: RadarSession): void {
  if (s.closed) return
  const cue = s.cue
  // With the native guide running it is the ONE sound/haptic source (it keeps
  // going when the screen locks; two sources would double-fire in the hand).
  if (cue.pattern !== 'silent' && !s.nativeGuide) {
    if (!s.muted && s.audio) {
      const bursts = cue.pattern === 'triple' ? 3 : cue.pattern === 'double' ? 2 : 1
      for (let i = 0; i < bursts; i++) beep(s.audio, cue.toneHz, i * 0.15, 0.07, cue.pan)
      // Warmer/colder second note (HOMING): a rising note when closing, a
      // falling one when receding — panned with the burst.
      if (cue.trend) {
        const second = cue.trend === 'closing' ? cue.toneHz * 1.5 : cue.toneHz * 0.7
        beep(s.audio, second, 0.09, 0.06, cue.pan)
      }
    }
    // Per-burst haptic mirror (always on — the pocket channel).
    try { navigator.vibrate?.(cue.vibrateMs) } catch { /* no haptics */ }
    // Signed turn haptic, offset to sit between this burst and the next.
    if (cue.sign) {
      window.clearTimeout(s.signTimer)
      const pattern = SIGN_HAPTIC[cue.sign]
      s.signTimer = window.setTimeout(() => {
        if (!s.closed && !s.nativeGuide) { try { navigator.vibrate?.(pattern) } catch { /* no haptics */ } }
      }, Math.max(120, cue.periodMs / 2))
    }
  }
  s.beepTimer = window.setTimeout(() => beepLoop(s), cue.pattern === 'silent' ? 300 : cue.periodMs)
}

/** One tracker blip-tone: triangle wave, fast attack, short decay, panned by the
 *  turn direction (`pan` −1 left … +1 right) so direction is audible in stereo. */
function beep(ctx: AudioContext, hz: number, delaySec: number, durSec: number, pan: number): void {
  try {
    const t = ctx.currentTime + delaySec
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = hz
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durSec)
    // osc → gain → [panner] → destination. StereoPanner is widely supported;
    // where it isn't, fall back to a centred (mono) connection.
    let tail: AudioNode = gain
    const makePanner = (ctx as unknown as { createStereoPanner?: () => StereoPannerNode }).createStereoPanner
    if (typeof makePanner === 'function' && pan !== 0) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, pan))
      gain.connect(panner)
      tail = panner
    }
    osc.connect(gain)
    tail.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + durSec + 0.02)
  } catch { /* audio unavailable — haptics still run */ }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

const escText = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/** Cycle the manual mode override: Auto → Vehicle → On foot → Homing → Auto. */
const OVERRIDE_CYCLE: (RadarMode | null)[] = [null, 'vector', 'seek', 'homing']

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
      <div class="radar-arrow" id="radar-arrow" hidden></div>
      <div class="radar-blip" id="radar-blip" hidden></div>
      <div class="radar-range" id="radar-range"></div>
      <div class="radar-self"></div>
    </div>
    <div class="radar-distance" id="radar-distance">—</div>
    <div class="radar-status" id="radar-status"></div>
    <div class="radar-controls">
      <button class="radar-modechip" id="radar-mode" aria-label="Guidance mode">Auto</button>
      <button class="radar-maps" id="radar-maps" hidden>🗺️ Open in Maps</button>
      <button class="radar-voice" id="radar-voice" aria-pressed="true">🗣️ Voice on</button>
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
  el.querySelector('#radar-voice')?.addEventListener('click', (e) => {
    const s = session
    if (!s) return
    s.voice = !s.voice
    if (!s.voice) { try { window.speechSynthesis?.cancel() } catch { /* no voice */ } }
    if (s.nativeGuide) void nativeGuideApi().then((m) => m?.setRadarGuideVoice(s.voice))
    const btn = e.currentTarget as HTMLElement
    btn.textContent = s.voice ? '🗣️ Voice on' : '🔇 Voice off'
    btn.setAttribute('aria-pressed', String(s.voice))
  })
  el.querySelector('#radar-mode')?.addEventListener('click', () => {
    const s = session
    if (!s) return
    const i = OVERRIDE_CYCLE.indexOf(s.modeOverride)
    s.modeOverride = OVERRIDE_CYCLE[(i + 1) % OVERRIDE_CYCLE.length]
  })
  // VECTOR's long-approach hand-off (radar-worlds-best §C): the road-network
  // part is a real nav app's job — radar stays open underneath for the final
  // unmapped stretch when the driver returns to it. Coordinates only: the
  // target's NAME is never URL-encoded into an intent another app receives.
  el.querySelector('#radar-maps')?.addEventListener('click', () => {
    const s = session
    if (!s) return
    const p = s.lastObservation?.position
    if (!p) return
    const lat = p.lat.toFixed(6)
    const lon = p.lon.toFixed(6)
    window.location.href = `geo:${lat},${lon}?q=${lat},${lon}`
  })
  return el
}
