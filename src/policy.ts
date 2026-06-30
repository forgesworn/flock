/**
 * Location-emission policy for flock — the "disclosure-on-event" core.
 *
 * This is the heart of the privacy model: a child's (or peer's) location is
 * **withheld by default** and only disclosed when an event justifies it. The
 * policy is a pure decision — given the current mode, position, safe zones and
 * any explicit trigger, it returns *what* to emit and at *what* precision. It
 * never encodes a geohash, encrypts, or performs I/O.
 *
 * Mirroring `canary-kit`'s beacon design, geohash encoding is the caller's
 * responsibility (e.g. `geohash-kit`'s `encode(lat, lon, precision)`), as is the
 * actual `encryptBeacon` call. This module only decides policy.
 *
 * Decision precedence (strongest intent first):
 *   help  >  pickup  >  geofence breach  >  night-out coarse  >  withhold
 */

import { isInside } from './geofence.js'
import type { LatLng, Geofence } from './geofence.js'

/** Operating mode. Family is asymmetric (guardian↔child); night-out is symmetric peers. */
export type EmissionMode = 'family' | 'nightout'

/** An explicit, user-initiated trigger. */
export type EmissionTrigger = 'none' | 'pickup' | 'help'

/** What the policy decides to broadcast. */
export type EmissionAction = 'withhold' | 'coarse' | 'full'

/** Why the policy reached its decision (drives the alert/signal the caller sends). */
export type EmissionReason = 'none' | 'nightout' | 'breach' | 'pickup' | 'help'

/** Geohash precisions for each disclosure level (1–11). */
export interface EmissionPrecisions {
  /** Coarse night-out beacons. Default 6 (~±0.6 km cell). */
  coarse: number
  /** Triggered full-disclosure beacons (pickup / breach). Default 9 (~±2.4 m). */
  full: number
  /** Help / SOS beacons — maximum precision. Default 11. */
  help: number
}

/** Default disclosure precisions. */
export const DEFAULT_PRECISIONS: EmissionPrecisions = { coarse: 6, full: 9, help: 11 }

/** Everything the policy needs to make a decision. */
export interface EmissionContext {
  mode: EmissionMode
  /** Current fix, or null/undefined when no location is available. */
  position?: LatLng | null
  /** Family safe zones. Being inside *any* zone is "safe"; outside *all* is a breach. */
  geofences?: Geofence[]
  /** Explicit user trigger; defaults to 'none'. */
  trigger?: EmissionTrigger
}

/** The policy's decision. */
export interface EmissionPlan {
  action: EmissionAction
  /** Geohash precision to emit at. 0 when withholding (nothing to emit). */
  precision: number
  reason: EmissionReason
}

function validatePrecision(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 11) {
    throw new Error(`Invalid ${label} precision: must be an integer between 1 and 11, got ${value}`)
  }
}

/**
 * True if `point` lies inside at least one of the supplied fences ("safe").
 * With no fences there is nothing to be inside, so this is false.
 */
export function isWithinAnyFence(point: LatLng, fences: Geofence[]): boolean {
  return fences.some((fence) => isInside(point, fence))
}

/**
 * Decide what location (if any) to disclose, given the current context.
 *
 * Pure and deterministic. When the position is unavailable a location beacon
 * cannot be emitted, so the action is always `withhold` — but the `reason`
 * still reflects any explicit trigger so the caller can send a location-less
 * alert (e.g. a help/SOS with `locationSource: 'none'`).
 *
 * @throws {Error} If any (resolved) precision is outside 1–11.
 */
export function decideEmission(
  ctx: EmissionContext,
  precisions?: Partial<EmissionPrecisions>,
): EmissionPlan {
  const p: EmissionPrecisions = { ...DEFAULT_PRECISIONS, ...precisions }
  validatePrecision(p.coarse, 'coarse')
  validatePrecision(p.full, 'full')
  validatePrecision(p.help, 'help')

  const trigger: EmissionTrigger = ctx.trigger ?? 'none'
  const position = ctx.position ?? null
  const hasPosition = position !== null

  // 1. Explicit user triggers win — strongest intent.
  if (trigger === 'help') {
    return hasPosition
      ? { action: 'full', precision: p.help, reason: 'help' }
      : { action: 'withhold', precision: 0, reason: 'help' }
  }
  if (trigger === 'pickup') {
    return hasPosition
      ? { action: 'full', precision: p.full, reason: 'pickup' }
      : { action: 'withhold', precision: 0, reason: 'pickup' }
  }

  // 2. Without a position there is nothing further to emit.
  if (!hasPosition) {
    return { action: 'withhold', precision: 0, reason: 'none' }
  }

  // 3. Family mode — disclose only on a geofence breach (outside every safe zone).
  if (ctx.mode === 'family') {
    const fences = ctx.geofences ?? []
    if (fences.length > 0 && !isWithinAnyFence(position, fences)) {
      return { action: 'full', precision: p.full, reason: 'breach' }
    }
    return { action: 'withhold', precision: 0, reason: 'none' }
  }

  // 4. Night-out mode — share a coarse, cloaked location.
  //    (Geohash truncation gives grid-cell cloaking; planar-Laplace noise for
  //    formal geo-indistinguishability is a future enhancement at the edge.)
  return { action: 'coarse', precision: p.coarse, reason: 'nightout' }
}
