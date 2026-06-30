/**
 * No-report zones — inverse geofences that *suppress* disclosure.
 *
 * Where a safe-zone breach is the trigger that flips location emission from
 * "withheld" to "disclose", a no-report zone does the opposite: while you are
 * inside one (home, a relative's, a refuge), your location is held back or
 * coarsened **even on a triggering event** — so a sensitive address is never
 * pinned at full precision, even by an SOS.
 *
 * Pure and on-device: zones never leave the phone and are evaluated locally
 * (see {@link decideEmission}, which applies the cap these helpers describe).
 */

import { isInside } from './geofence.js'
import type { LatLng, Geofence } from './geofence.js'

/**
 * How strongly a no-report zone suppresses disclosure:
 * - `withhold` — emit nothing while inside (full dark over a sensitive spot).
 * - `coarse`   — cap to coarse precision (a grid cell, never the exact building).
 */
export type NoReportPolicy = 'withhold' | 'coarse'

/** An inverse geofence: inside it, location disclosure is suppressed. */
export interface NoReportZone {
  /** The area this zone covers (reuses the same shapes as safe zones). */
  area: Geofence
  /** Suppression strength; defaults to `withhold` (the most protective). */
  policy?: NoReportPolicy
  /** Optional human label (e.g. "Home", "Nan's"). */
  label?: string
}

/** True if `point` falls inside at least one no-report zone. */
export function inNoReportZone(point: LatLng, zones: NoReportZone[]): boolean {
  return zones.some((z) => isInside(point, z.area))
}

/**
 * The strictest suppression policy among the zones containing `point`, or
 * `null` when the point is in no zone. `withhold` is stricter than `coarse`,
 * and an unspecified zone policy defaults to `withhold`.
 */
export function noReportPolicyAt(point: LatLng, zones: NoReportZone[]): NoReportPolicy | null {
  let strictest: NoReportPolicy | null = null
  for (const z of zones) {
    if (!isInside(point, z.area)) continue
    const p = z.policy ?? 'withhold'
    if (p === 'withhold') return 'withhold' // strictest possible — short-circuit
    strictest = 'coarse'
  }
  return strictest
}
