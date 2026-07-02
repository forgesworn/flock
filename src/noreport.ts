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
 *
 * Accuracy fails safe in the OPPOSITE direction to breach detection: a breach
 * fires only when the fix is *confidently outside* every safe zone, but the
 * no-report cap applies unless the fix is confidently outside the zone — a fix
 * whose uncertainty disc *might* cover a sensitive address is treated as inside
 * it, so a noisy GPS fix at home never pins the building.
 */

import { classifyContainment } from './geofence.js'
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

/**
 * True if `point` — with its uncertainty radius — is *possibly* inside at least
 * one no-report zone. Only a fix confidently outside every zone returns false
 * (the fail-safe direction for redaction). Accuracy 0 is the crisp check.
 */
export function inNoReportZone(point: LatLng, zones: NoReportZone[], accuracyMetres = 0): boolean {
  return classifyContainment(point, accuracyMetres, zones.map((z) => z.area)) !== 'outside'
}

/**
 * The strictest suppression policy among the zones `point` is possibly inside
 * (given its uncertainty radius), or `null` when confidently outside them all.
 * `withhold` is stricter than `coarse`, and an unspecified zone policy defaults
 * to `withhold`. Accuracy 0 collapses to the crisp containment check.
 */
export function noReportPolicyAt(point: LatLng, zones: NoReportZone[], accuracyMetres = 0): NoReportPolicy | null {
  let strictest: NoReportPolicy | null = null
  for (const z of zones) {
    if (classifyContainment(point, accuracyMetres, [z.area]) === 'outside') continue
    const p = z.policy ?? 'withhold'
    if (p === 'withhold') return 'withhold' // strictest possible — short-circuit
    strictest = 'coarse'
  }
  return strictest
}
