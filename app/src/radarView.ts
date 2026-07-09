// Pure helpers behind the radar tracker view — the math and copy that can be
// unit-tested without a DOM. The controller (radarMode.ts) owns sensors,
// audio and rendering; everything decidable from plain values lives here.

import type { RadarGuidance } from '@forgesworn/flock'

/** Normalise an angle to [0, 360). */
const norm360 = (deg: number): number => {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/**
 * Device heading (deg clockwise from north) from a DeviceOrientation event,
 * or null when the event can't honestly give one.
 *
 * iOS Safari exposes `webkitCompassHeading` (already a compass heading).
 * Elsewhere only an ABSOLUTE event's `alpha` is earth-referenced
 * (`deviceorientationabsolute`, or `absolute: true`); a relative event's alpha
 * has an arbitrary zero and would point somewhere confident and wrong — so it
 * yields null, which the radar reports as "no compass" (the honest fallback).
 * `screenAngle` compensates for a rotated screen (screen.orientation.angle).
 */
export function headingFromOrientation(
  e: { alpha: number | null; absolute?: boolean; webkitCompassHeading?: number },
  screenAngle = 0,
): number | null {
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    return norm360(e.webkitCompassHeading + screenAngle)
  }
  if (e.absolute && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    return norm360(360 - e.alpha + screenAngle)
  }
  return null
}

/** How far from the centre a blip may sit (fraction of the scope radius) —
 *  anything further clamps to the rim, reading as "beyond this scope". */
export const BLIP_MAX_RADIUS = 0.92

/**
 * Project the target onto the scope: unit coordinates with +x right and +y
 * DOWN (screen space), the scope's up axis being "ahead". `angleDeg` is the
 * bearing relative to the scope's up (device heading normally, north when
 * there's no compass); distance beyond the range clamps to the rim.
 */
export function blipXY(angleDeg: number, distanceMetres: number, rangeMetres: number): { x: number; y: number } {
  const r = Math.min(BLIP_MAX_RADIUS, (distanceMetres / rangeMetres) * BLIP_MAX_RADIUS)
  const theta = (angleDeg * Math.PI) / 180
  return { x: r * Math.sin(theta), y: -r * Math.cos(theta) }
}

/** Scope full-scale candidates, metres — familiar round numbers. The 10 m
 *  floor is the endgame dial: arrival fires at ~2 m (or the disclosed cell),
 *  so the last approach plays out across the full scope; tighter than 10 m
 *  would just magnify fix noise. */
const RANGE_STEPS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000] as const

/** Headroom keeping the blip off the rim; a step is picked when span × this fits. */
const RANGE_HEADROOM = 1.15
/** Stricter headroom for ZOOMING IN — the gap between the two is the
 *  hysteresis dead band that stops GPS jitter flapping the scale. */
const ZOOM_IN_HEADROOM = 1.35

/**
 * Pick the scope's full-scale range: the first round step that leaves the blip
 * comfortably inside the rim, so the scope zooms in as the target closes and
 * the final approach fills the dial instead of crawling around its centre.
 *
 * Honesty rule: the scope never zooms tighter than the disclosed uncertainty —
 * a loose share keeps its honesty band inside the rim rather than gaining a
 * precise-looking close-up it never disclosed.
 *
 * With `prevRange` (the scope currently shown) the change is damped: zooming
 * OUT is immediate (a retreating target must never sit hidden at the rim), but
 * zooming IN waits until the span fits the smaller scope with extra headroom.
 * Null distance (no data yet) keeps the current scope, or a mid default.
 */
export function niceRange(
  distanceMetres: number | null,
  uncertaintyMetres = 0,
  prevRange: number | null = null,
): number {
  if (distanceMetres === null || !Number.isFinite(distanceMetres)) return prevRange ?? 500
  const span = Math.max(distanceMetres, uncertaintyMetres)
  const stepFor = (headroom: number): number =>
    RANGE_STEPS.find((step) => span * headroom <= step) ?? RANGE_STEPS[RANGE_STEPS.length - 1]
  const ideal = stepFor(RANGE_HEADROOM)
  if (prevRange === null || ideal >= prevRange) return ideal
  const zoomedIn = stepFor(ZOOM_IN_HEADROOM)
  return zoomedIn < prevRange ? zoomedIn : prevRange
}

/** "just now" / "18 s old" / "4 min old" — the freshness readout. */
export function freshnessLabel(ageSeconds: number): string {
  if (ageSeconds < 10) return 'just now'
  if (ageSeconds < 90) return `${Math.round(ageSeconds)} s old`
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)} min old`
  return `${Math.floor(ageSeconds / 3600)} h old`
}

/**
 * The one status line under the scope — plain words for every degraded state
 * ("stale", "rough area", "no compass"), empty when guidance is fully live so
 * the tracker stays quiet. `fmt` renders metres in the user's units.
 */
export function statusCopy(g: RadarGuidance, fmt: (metres: number) => string): string {
  switch (g.state) {
    case 'unavailable':
      return 'No location to navigate to — they may be private or out of reach'
    case 'no-fix':
      return 'Waiting for your own position…'
    case 'stale':
      return 'Last position is stale — follow with care'
    case 'coarse':
      return `Rough area only — they're within ${fmt(g.uncertaintyMetres ?? 0).replace('~', '')}`
    case 'no-heading':
      return 'No compass — walk a few steps and follow the distance'
    case 'arrived':
      return 'You’re here — look around'
    case 'point':
      return ''
  }
}
