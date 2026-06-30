/**
 * Night-out mode for flock — ephemeral, symmetric, consent-based group sharing.
 *
 * Unlike family mode (asymmetric guardian↔child, withhold-until-breach), a night
 * out is a group of peers sharing coarse location for a bounded window. This
 * module covers:
 *   - time-boxing the group with a NIP-40 `expiration` (auto-dissolve),
 *   - presence: "who's still out / who's gone home" from recent beacons,
 *   - separation: "is anyone split from the group" (a lost-friend signal).
 *
 * All functions are pure and take `now` explicitly where time matters, so they
 * are deterministic and testable. Geohash encoding/decoding and encryption stay
 * the caller's responsibility (per `canary-kit`'s beacon design).
 */

import { haversineMetres } from './geofence.js'
import type { LatLng } from './geofence.js'
import { buildGroupStateEvent, type UnsignedEvent } from 'canary-kit/nostr'

// ── Ephemeral group lifetime ──────────────────────────────────────────────────

/**
 * Compute the NIP-40 `expiration` timestamp for a time-boxed night-out group.
 *
 * @param startedAt - Unix seconds when the night out began.
 * @param durationSeconds - How long the group should live, in seconds.
 * @returns The unix-seconds expiration (`startedAt + durationSeconds`).
 * @throws {Error} If inputs are not valid positive/non-negative integers.
 */
export function nightOutExpiry(startedAt: number, durationSeconds: number): number {
  if (!Number.isInteger(startedAt) || startedAt < 0) {
    throw new Error('startedAt must be a non-negative integer (unix seconds)')
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error('durationSeconds must be a positive integer (seconds)')
  }
  return startedAt + durationSeconds
}

/** Parameters for a time-boxed night-out group-state event. */
export interface NightOutGroupParams {
  groupId: string
  /** 64-char lowercase hex pubkeys of the participants. */
  members: string[]
  /** NIP-44-encrypted group config (caller-encrypted). */
  encryptedContent: string
  /** Unix seconds when the night out began. */
  startedAt: number
  /** How long the group should live, in seconds. */
  durationSeconds: number
  rotationInterval?: number
  tolerance?: number
}

/**
 * Build an unsigned kind-30078 group-state event for a night out, carrying a
 * NIP-40 `expiration` so relays drop it (and clients stop honouring it) once the
 * night is over.
 */
export function buildNightOutGroupEvent(params: NightOutGroupParams): UnsignedEvent {
  const expiration = nightOutExpiry(params.startedAt, params.durationSeconds)
  return buildGroupStateEvent({
    groupId: params.groupId,
    members: params.members,
    encryptedContent: params.encryptedContent,
    expiration,
    ...(params.rotationInterval !== undefined && { rotationInterval: params.rotationInterval }),
    ...(params.tolerance !== undefined && { tolerance: params.tolerance }),
  })
}

// ── Presence: who's still out / gone home ─────────────────────────────────────

/** A member's most recent location beacon (decrypted). */
export interface MemberBeacon {
  member: string
  geohash: string
  precision: number
  /** Unix seconds. */
  timestamp: number
}

/** Whether a member is still actively sharing, or has gone quiet ("home"). */
export type PresenceStatus = 'active' | 'stale'

/** A member's presence, derived from their latest beacon. */
export interface PresenceEntry {
  member: string
  status: PresenceStatus
  /** Timestamp of the latest beacon. */
  lastSeen: number
  /** `now - lastSeen`, in seconds. */
  ageSeconds: number
  /** Geohash of the latest beacon. */
  geohash: string
}

/** Beacons older than this (seconds) mark a member 'stale' — likely gone home. */
export const DEFAULT_STALE_AFTER_SECONDS = 600

/**
 * Classify each member's presence from their beacons. Collapses to the latest
 * beacon per member and marks them `stale` if it is older than the threshold.
 * Result is sorted most-recent-first.
 *
 * @throws {Error} If `staleAfterSeconds` is not a positive integer.
 */
export function classifyPresence(
  beacons: MemberBeacon[],
  now: number,
  opts?: { staleAfterSeconds?: number },
): PresenceEntry[] {
  const staleAfter = opts?.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS
  if (!Number.isInteger(staleAfter) || staleAfter <= 0) {
    throw new Error('staleAfterSeconds must be a positive integer (seconds)')
  }

  const latest = new Map<string, MemberBeacon>()
  for (const b of beacons) {
    const prev = latest.get(b.member)
    if (!prev || b.timestamp > prev.timestamp) latest.set(b.member, b)
  }

  const entries: PresenceEntry[] = []
  for (const b of latest.values()) {
    const ageSeconds = now - b.timestamp
    entries.push({
      member: b.member,
      status: ageSeconds > staleAfter ? 'stale' : 'active',
      lastSeen: b.timestamp,
      ageSeconds,
      geohash: b.geohash,
    })
  }
  entries.sort((a, b) => b.lastSeen - a.lastSeen)
  return entries
}

/** The members still actively sharing (e.g. "still at the bar"). */
export function stillOut(entries: PresenceEntry[]): PresenceEntry[] {
  return entries.filter((e) => e.status === 'active')
}

// ── Separation: is anyone split from the group ────────────────────────────────

/** A member's decoded position (caller decodes the geohash). */
export interface MemberPosition {
  member: string
  position: LatLng
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Identify members who are further than `thresholdMetres` from the group's
 * centre — a "someone's wandered off / got lost" signal.
 *
 * Uses a component-wise **median** centre, which is robust to outliers: one
 * member who has split off does not drag the centre toward themselves and make
 * the rest of the (clustered) group read as outliers too. Accurate at the city
 * scale a night out spans.
 *
 * @returns The pubkeys of outlying members (empty if all are clustered).
 * @throws {Error} If `thresholdMetres` is not a positive number.
 */
export function geoOutliers(points: MemberPosition[], thresholdMetres: number): string[] {
  if (!Number.isFinite(thresholdMetres) || thresholdMetres <= 0) {
    throw new Error('thresholdMetres must be a positive number')
  }
  if (points.length === 0) return []

  const centre: LatLng = {
    lat: median(points.map((p) => p.position.lat)),
    lon: median(points.map((p) => p.position.lon)),
  }
  return points
    .filter((p) => haversineMetres(p.position, centre) > thresholdMetres)
    .map((p) => p.member)
}
