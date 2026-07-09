/**
 * Radar navigation to a person — the pure math and cue state.
 *
 * Turns "my fix + their disclosed location + my device heading" into an honest
 * guidance state and a beep/haptic cadence, so the privacy and stale-data rules
 * live here (tested) rather than in DOM code. The UI layer renders the state
 * and plays the cue; this module never touches sensors, audio or transport.
 *
 * The honest model (see docs/plans/2026-07-09-radar-navigation-goal.md): radar
 * is a better way to CONSUME a permitted disclosure, not a new power to obtain
 * one. So a coarse share is never presented as a precise pointer, a stale
 * target degrades the cue instead of guiding confidently, and a withheld /
 * absent target reads as unavailable — never a fabricated position.
 *
 * Pure, synchronous, deterministic — no I/O, no Date.now(), no mutation.
 * Ages and positions are inputs; geohash decoding stays at the edge.
 */

import { haversineMetres, type LatLng } from './geofence.js'

/** Tuning constants — exported so the UI and tests share one vocabulary. */
export const RADAR = {
  /** A fix this young reads as "just now". */
  freshSeconds: 60,
  /** Beyond this the target is stale — matches the app's presence window. */
  staleSeconds: 600,
  /** Within this of a precise target you have arrived — the endgame runs to
   *  touching distance. The disclosed uncertainty still caps it (an exact
   *  share arrives at its ~2.4 m cell), so this never claims sub-cell
   *  precision; it only stops guidance going silent 15 m short. */
  arriveMetres: 2,
  /** Disclosed uncertainty above this is a coarse share — area guidance only. */
  coarseUncertaintyMetres: 50,
  /** |angular error| at or under this counts as aligned. */
  alignedDegrees: 20,
  /** …and at or under this as nearly aligned (correcting). */
  nearDegrees: 60,
  /** Distance tiers for the cue cadence. */
  closeMetres: 75,
  nearMetres: 300,
  /** A target shift under this floor is GPS jitter, not movement. */
  minMoveMetres: 25,
  /** Own-movement floor before a GPS course over ground is trusted. */
  minCourseMetres: 8,
  /** A bearing to a point you may already be inside is fiction — require the
   *  distance to clear the uncertainty by this factor before pointing. */
  bearingSlackFactor: 1.25,
} as const

export type RadarOptions = typeof RADAR

/** The selected person's disclosed location, as the radar consumes it: a
 *  position (the cell centre for a coarse share), the disclosed uncertainty
 *  radius, and how old the observation is. */
export interface TargetObservation {
  position: LatLng
  uncertaintyMetres: number
  ageSeconds: number
}

/** Everything the guidance decision needs, gathered by the caller. */
export interface RadarInput {
  /** My latest fix, or null when the phone has none yet. */
  me: LatLng | null
  /** Device heading in degrees clockwise from north, or null (no compass). */
  headingDeg: number | null
  /** The selected target, or null (not sharing / withheld / no beacon). */
  target: TargetObservation | null
}

export type Freshness = 'fresh' | 'aging' | 'stale'
export type Alignment = 'aligned' | 'near' | 'off'

/**
 * The guidance state, in strict honesty order:
 *  - `unavailable` — nothing to navigate to; say so, never point.
 *  - `no-fix`      — the target exists but I don't know where I am yet.
 *  - `stale`       — their last fix is too old to guide by.
 *  - `coarse`      — they share an area, not a spot: range guidance only.
 *  - `arrived`     — within arrival range of a live precise target.
 *  - `no-heading`  — live target but no compass: distance-paced fallback.
 *  - `point`       — full bearing guidance.
 */
export type RadarState = 'unavailable' | 'no-fix' | 'stale' | 'coarse' | 'arrived' | 'no-heading' | 'point'

export interface RadarGuidance {
  state: RadarState
  /** Metres to the disclosed position, or null when either side is unknown. */
  distanceMetres: number | null
  /** True bearing me → target (deg from north), or null when unknown. */
  bearingDeg: number | null
  /** Bearing relative to the device heading, -180..180 (null without both). */
  relativeBearingDeg: number | null
  freshness: Freshness | null
  /** Alignment tier — only ever set when the bearing is honestly usable. */
  alignment: Alignment | null
  /** May the UI/cue present the bearing as guidance? False for coarse, stale,
   *  or a distance inside the uncertainty (pointing would overclaim). */
  bearingUsable: boolean
  /** The disclosed uncertainty radius, for the UI's honesty band. */
  uncertaintyMetres: number | null
}

/** One beep/haptic cadence step, held until the guidance changes.
 *  Pattern vocabulary is the goal doc's grammar: "beep ... beep ...
 *  beep beep ... beep beep beep", plus sparse (degraded) and silent. */
export interface RadarCue {
  pattern: 'silent' | 'sparse' | 'single' | 'double' | 'triple'
  /** Time between bursts. Meaningless for `silent`. */
  periodMs: number
  /** Oscillator pitch; 0 for silent. */
  toneHz: number
  /** One burst's vibration pattern (navigator.vibrate shape). */
  vibrateMs: number[]
}

function validateLatLng(p: LatLng, label: string): void {
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' ||
      Number.isNaN(p.lat) || Number.isNaN(p.lon)) {
    throw new Error(`Invalid ${label}: lat and lon must be numbers`)
  }
  if (p.lat < -90 || p.lat > 90) {
    throw new Error(`Invalid ${label}: lat must be between -90 and 90, got ${p.lat}`)
  }
  if (p.lon < -180 || p.lon > 180) {
    throw new Error(`Invalid ${label}: lon must be between -180 and 180, got ${p.lon}`)
  }
}

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Normalise an angle to [0, 360). */
function norm360(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/**
 * Initial great-circle bearing from `a` towards `b`, degrees clockwise from
 * north, in [0, 360).
 *
 * @throws {Error} If either coordinate is out of range.
 */
export function initialBearingDeg(a: LatLng, b: LatLng): number {
  validateLatLng(a, 'point a')
  validateLatLng(b, 'point b')
  const phi1 = toRad(a.lat)
  const phi2 = toRad(b.lat)
  const dLambda = toRad(b.lon - a.lon)
  const y = Math.sin(dLambda) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda)
  return norm360(toDeg(Math.atan2(y, x)))
}

/**
 * Signed angular error between the target bearing and the device heading, in
 * (-180, 180]: positive = the target is to the right (turn clockwise).
 */
export function angularErrorDeg(bearingDeg: number, headingDeg: number): number {
  const d = norm360(bearingDeg - headingDeg)
  return d > 180 ? d - 360 : d
}

/** Age → freshness tier. The stale window matches the app's presence view, so
 *  the tracker and the map never tell two different stories. */
export function classifyFreshness(ageSeconds: number, opts: RadarOptions = RADAR): Freshness {
  if (ageSeconds <= opts.freshSeconds) return 'fresh'
  if (ageSeconds <= opts.staleSeconds) return 'aging'
  return 'stale'
}

/** The guidance decision — see {@link RadarState} for the honesty order. */
export function radarGuidance(input: RadarInput, opts: RadarOptions = RADAR): RadarGuidance {
  const none: RadarGuidance = {
    state: 'unavailable',
    distanceMetres: null,
    bearingDeg: null,
    relativeBearingDeg: null,
    freshness: null,
    alignment: null,
    bearingUsable: false,
    uncertaintyMetres: null,
  }
  if (!input.target) return none

  const t = input.target
  const freshness = classifyFreshness(t.ageSeconds, opts)
  if (!input.me) {
    return { ...none, state: 'no-fix', freshness, uncertaintyMetres: t.uncertaintyMetres }
  }

  const distanceMetres = haversineMetres(input.me, t.position)
  const bearingDeg = initialBearingDeg(input.me, t.position)
  const relativeBearingDeg = input.headingDeg === null ? null : angularErrorDeg(bearingDeg, input.headingDeg)
  const coarse = t.uncertaintyMetres > opts.coarseUncertaintyMetres

  const bearingUsable =
    !coarse &&
    freshness !== 'stale' &&
    distanceMetres > t.uncertaintyMetres * opts.bearingSlackFactor

  const alignment: Alignment | null =
    bearingUsable && relativeBearingDeg !== null
      ? Math.abs(relativeBearingDeg) <= opts.alignedDegrees
        ? 'aligned'
        : Math.abs(relativeBearingDeg) <= opts.nearDegrees
          ? 'near'
          : 'off'
      : null

  const state: RadarState =
    freshness === 'stale'
      ? 'stale'
      : !coarse && distanceMetres <= Math.max(opts.arriveMetres, t.uncertaintyMetres)
        ? 'arrived'
        : coarse
          ? 'coarse'
          : input.headingDeg === null
            ? 'no-heading'
            : 'point'

  return {
    state,
    distanceMetres,
    bearingDeg,
    relativeBearingDeg,
    freshness,
    alignment,
    bearingUsable,
    uncertaintyMetres: t.uncertaintyMetres,
  }
}

/** The degraded low pulse — deliberately duller and slower than any live cue,
 *  so stale/coarse/unavailable can never be mistaken for confident guidance. */
const SPARSE_TONE_HZ = 330

/**
 * Guidance → one cadence step of the beep grammar.
 *
 * The invariants the tests hold: cadence accelerates and brightens only as the
 * user aligns and closes on a LIVE precise target; every degraded state is a
 * sparse dull pulse; arrival is immediate silence plus one confirming haptic;
 * every audible cue has a haptic mirror.
 */
export function cueFor(g: RadarGuidance, opts: RadarOptions = RADAR): RadarCue {
  switch (g.state) {
    case 'unavailable':
    case 'no-fix':
      return { pattern: 'sparse', periodMs: 4000, toneHz: SPARSE_TONE_HZ, vibrateMs: [30] }
    case 'stale':
      return { pattern: 'sparse', periodMs: 3500, toneHz: SPARSE_TONE_HZ, vibrateMs: [30] }
    case 'coarse': {
      // Range-only guidance: quicken slightly as the disclosed area nears, but
      // stay sparse — a coarse share must never sound like a precise pointer.
      const d = g.distanceMetres ?? Infinity
      const u = g.uncertaintyMetres ?? opts.coarseUncertaintyMetres
      const periodMs = d <= u ? 2000 : d <= u * 3 ? 2400 : 3000
      return { pattern: 'sparse', periodMs, toneHz: 440, vibrateMs: [40] }
    }
    case 'arrived':
      return { pattern: 'silent', periodMs: 0, toneHz: 0, vibrateMs: [80, 60, 80] }
    case 'no-heading': {
      // Walk-a-few-steps fallback: distance-paced pulse, no bearing claim.
      const d = g.distanceMetres ?? Infinity
      const periodMs = d < opts.closeMetres ? 1000 : d < opts.nearMetres ? 1600 : 2400
      return { pattern: 'single', periodMs, toneHz: 660, vibrateMs: [40] }
    }
    case 'point': {
      const d = g.distanceMetres ?? Infinity
      switch (g.alignment) {
        case 'aligned':
          return d < opts.closeMetres
            ? { pattern: 'triple', periodMs: 700, toneHz: 1175, vibrateMs: [40, 60, 40, 60, 40] }
            : { pattern: 'double', periodMs: 1100, toneHz: 990, vibrateMs: [40, 60, 40] }
        case 'near':
          return { pattern: 'single', periodMs: 1600, toneHz: 740, vibrateMs: [40] }
        case 'off':
          return { pattern: 'single', periodMs: 2400, toneHz: 494, vibrateMs: [30] }
        default:
          // Bearing not honestly usable (e.g. just outside arrival range of an
          // uncertain-but-precise target) — distance pulse, no bearing claim.
          return { pattern: 'single', periodMs: 1600, toneHz: 660, vibrateMs: [40] }
      }
    }
  }
}

/** A position with its disclosed uncertainty — the movement comparison unit. */
export interface PositionObservation {
  position: LatLng
  uncertaintyMetres: number
}

/**
 * Did the target genuinely move between two observations? True only when the
 * shift exceeds both the jitter floor and each observation's own uncertainty —
 * a coarse share "moves" only on a cell-sized change, and a precise one never
 * "moves" on GPS noise. The UI uses this for the distinct "target moved" pulse.
 */
export function targetMoved(
  prev: PositionObservation | null,
  next: PositionObservation,
  opts: RadarOptions = RADAR,
): boolean {
  if (!prev) return false
  const d = haversineMetres(prev.position, next.position)
  return d > Math.max(opts.minMoveMetres, prev.uncertaintyMetres, next.uncertaintyMetres)
}

/** A fix of my own, timestamped, for the course-over-ground fallback. */
export interface TimedPosition {
  position: LatLng
  atSec: number
}

/**
 * Course over ground from two of my own fixes — the heading fallback when the
 * compass is missing or unreliable ("walk a few steps"). Null when the fixes
 * are too close to trust (jitter) or out of order.
 */
export function courseFromFixes(
  prev: TimedPosition,
  next: TimedPosition,
  minMetres: number = RADAR.minCourseMetres,
): number | null {
  if (next.atSec <= prev.atSec) return null
  if (haversineMetres(prev.position, next.position) < minMetres) return null
  return initialBearingDeg(prev.position, next.position)
}
