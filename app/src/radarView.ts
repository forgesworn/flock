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

/** Scope full-scale candidates, metres — familiar round numbers. */
const RANGE_STEPS = [100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000] as const

/** Pick the scope's full-scale range for a distance: the first round step that
 *  leaves the blip comfortably inside the rim. Null distance (no data yet)
 *  gets a mid default; beyond the largest step clamps (the blip rides the rim,
 *  honestly reading "further than this scope shows"). */
export function niceRange(distanceMetres: number | null): number {
  if (distanceMetres === null || !Number.isFinite(distanceMetres)) return 500
  for (const step of RANGE_STEPS) {
    if (distanceMetres * 1.15 <= step) return step
  }
  return RANGE_STEPS[RANGE_STEPS.length - 1]
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
