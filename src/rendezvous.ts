/**
 * Rendezvous — "be at a place by a time".
 *
 * Someone sets a rendezvous (place + deadline + mode); each device computes its
 * own ETA, detects arrival, and broadcasts a coarse status (en-route / arrived /
 * at-risk) so the setter knows who's going to make it. The *where* (finding a
 * fair meeting point for everyone) is `rendezvous-kit`'s job at the app edge;
 * this module is the *when* — pure ETA/arrival logic + the encrypted signals.
 *
 * ETA is a straight-line distance ÷ travel-mode speed estimate (good enough, no
 * routing engine). Speeds mirror rendezvous-kit's.
 */

import { haversineMetres, type LatLng } from './geofence.js'
import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

export type RendezvousMode = 'be-back' | 'meet-at'
export type TravelMode = 'walk' | 'cycle' | 'drive' | 'transit'
export type ArrivalStatus = 'enroute' | 'arrived' | 'at-risk'

/** Travel speeds (km/h) for the straight-line ETA estimate. */
export const SPEED_KMH: Record<TravelMode, number> = { walk: 5, cycle: 15, drive: 30, transit: 20 }

/** Within this distance of the place counts as "arrived". */
export const DEFAULT_ARRIVAL_RADIUS_M = 60

const HEX_64_RE = /^[0-9a-f]{64}$/

/** The `t`-tag for the rendezvous definition and for member status updates. */
export const RENDEZVOUS_SIGNAL_TYPE = 'rzv'
export const RENDEZVOUS_STATUS_TYPE = 'rzv-status'

/** A rendezvous: be at `place` by `deadline`. */
export interface Rendezvous {
  id: string
  place: LatLng & { label?: string }
  /** Unix seconds. */
  deadline: number
  mode: RendezvousMode
  /** 64-hex pubkey of whoever set it. */
  setBy: string
  /** Unix seconds. */
  createdAt: number
}

/** A member's computed progress toward a rendezvous. */
export interface RendezvousProgress {
  member: string
  status: ArrivalStatus
  distanceMetres: number
  etaSeconds: number
  /** Unix sec by which they must leave to arrive by the deadline. */
  leaveBy: number
  /** deadline − projected arrival; ≥0 on track, <0 at-risk. */
  slackSeconds: number
}

/** The coarse status a member broadcasts (no exact position — just status + ETA). */
export interface RendezvousStatus {
  rendezvousId: string
  member: string
  status: ArrivalStatus
  etaSeconds: number
  timestamp: number
}

/** Estimated travel time (seconds) to cover a distance at a travel mode's speed. */
export function etaSeconds(distanceMetres: number, mode: TravelMode): number {
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0) {
    throw new Error('distanceMetres must be a non-negative number')
  }
  const kmh = SPEED_KMH[mode]
  if (!kmh) throw new Error(`Unknown travel mode: ${mode}`)
  return distanceMetres / ((kmh * 1000) / 3600)
}

/**
 * Assess a member's progress toward a rendezvous from their current position.
 * `arrived` if within the arrival radius; `at-risk` if projected arrival is after
 * the deadline; otherwise `enroute`.
 */
export function assessArrival(
  rendezvous: Rendezvous,
  member: string,
  position: LatLng,
  mode: TravelMode,
  now: number,
  opts?: { arrivalRadiusMetres?: number },
): RendezvousProgress {
  const arrivalRadius = opts?.arrivalRadiusMetres ?? DEFAULT_ARRIVAL_RADIUS_M
  if (!Number.isFinite(arrivalRadius) || arrivalRadius <= 0) {
    throw new Error('arrivalRadiusMetres must be a positive number')
  }
  const distanceMetres = haversineMetres(position, rendezvous.place)
  const eta = etaSeconds(distanceMetres, mode)
  const projectedArrival = now + eta
  let status: ArrivalStatus = 'enroute'
  if (distanceMetres <= arrivalRadius) status = 'arrived'
  else if (projectedArrival > rendezvous.deadline) status = 'at-risk'
  return {
    member,
    status,
    distanceMetres,
    etaSeconds: eta,
    leaveBy: rendezvous.deadline - eta,
    slackSeconds: rendezvous.deadline - projectedArrival,
  }
}

// ── Encrypted signals (group envelope key) ────────────────────────────────────

function validateRendezvous(o: Record<string, unknown>): Rendezvous {
  const place = o.place as Record<string, unknown> | undefined
  if (typeof o.id !== 'string' || !o.id) throw new Error('Invalid rendezvous: id')
  if (!place || typeof place.lat !== 'number' || typeof place.lon !== 'number') throw new Error('Invalid rendezvous: place')
  if (typeof o.deadline !== 'number' || !Number.isFinite(o.deadline)) throw new Error('Invalid rendezvous: deadline')
  if (o.mode !== 'be-back' && o.mode !== 'meet-at') throw new Error('Invalid rendezvous: mode')
  if (typeof o.setBy !== 'string' || !HEX_64_RE.test(o.setBy)) throw new Error('Invalid rendezvous: setBy')
  if (typeof o.createdAt !== 'number') throw new Error('Invalid rendezvous: createdAt')
  return {
    id: o.id,
    place: { lat: place.lat, lon: place.lon, ...(typeof place.label === 'string' && { label: place.label }) },
    deadline: o.deadline,
    mode: o.mode,
    setBy: o.setBy,
    createdAt: o.createdAt,
  }
}

/** Build an unsigned kind-20078 rendezvous-definition signal (group-envelope encrypted). */
export async function buildRendezvousSignal(params: { groupId: string; seedHex: string; rendezvous: Rendezvous }): Promise<UnsignedEvent> {
  validateRendezvous(params.rendezvous as unknown as Record<string, unknown>)
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(params.rendezvous))
  return buildSignalEvent({ groupId: params.groupId, signalType: RENDEZVOUS_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a rendezvous-definition signal. */
export async function decryptRendezvous(seedHex: string, content: string): Promise<Rendezvous> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  return validateRendezvous(JSON.parse(plaintext) as Record<string, unknown>)
}

/** Build an unsigned kind-20078 rendezvous-status signal (group-envelope encrypted). */
export async function buildRendezvousStatusSignal(params: { groupId: string; seedHex: string; status: RendezvousStatus }): Promise<UnsignedEvent> {
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(params.status))
  return buildSignalEvent({ groupId: params.groupId, signalType: RENDEZVOUS_STATUS_TYPE, encryptedContent })
}

/** Decrypt a rendezvous-status signal. */
export async function decryptRendezvousStatus(seedHex: string, content: string): Promise<RendezvousStatus> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  const o = JSON.parse(plaintext) as Record<string, unknown>
  if (typeof o.rendezvousId !== 'string' || typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid rendezvous status: rendezvousId/member')
  }
  if (o.status !== 'enroute' && o.status !== 'arrived' && o.status !== 'at-risk') {
    throw new Error('Invalid rendezvous status: status')
  }
  if (typeof o.etaSeconds !== 'number' || typeof o.timestamp !== 'number') {
    throw new Error('Invalid rendezvous status: etaSeconds/timestamp')
  }
  return { rendezvousId: o.rendezvousId, member: o.member, status: o.status, etaSeconds: o.etaSeconds, timestamp: o.timestamp }
}
