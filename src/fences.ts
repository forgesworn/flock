/**
 * Fence sync — a circle's safe places, shared as an encrypted full-replacement set.
 *
 * A guardian drawing "school = safe place" must govern every member's device, not
 * just their own: breach evaluation is on-device (FLOCK.md §3.2/§6.4), so each
 * device needs the same fence set. This module carries that set to the circle as
 * an ordinary group-envelope signal (`t=fences`) — gift-wrapped by the app like
 * every other signal, so the relay sees nothing.
 *
 * Semantics are deliberately simple — idempotent full-state, latest-wins:
 * every edit publishes the WHOLE set with a fresh `updatedAt`; receivers apply it
 * only when `isNewerFenceSet` says so (newer clock wins; equal clocks tie-break on
 * the lexicographically smaller author, so concurrent edits converge everywhere;
 * an exact echo is a no-op). No CRDT, no deltas — a fence set is small and edits
 * are rare. Role-gated editing (guardians only) arrives with dominion.
 *
 * Note this shares safe places only. No-report zones ("private places") are the
 * opposite by design: on-device only, never transmitted (see PRIVACY.md).
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'
import type { Geofence, LatLng } from './geofence.js'

/** The `t`-tag value for fence-sync signals. */
export const FENCES_SIGNAL_TYPE = 'fences'

/** Upper bound on fences per set — bounds payload size; far beyond real use. */
export const MAX_FENCES = 50

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A circle's complete safe-place set, plus the latest-wins clock and author. */
export interface FenceSet {
  fences: Geofence[]
  /** Unix seconds of the edit this set represents. */
  updatedAt: number
  /** The editor's pubkey (64-char hex) — the deterministic tie-break. */
  by: string
}

function isLatLng(v: unknown): v is LatLng {
  const o = v as LatLng
  return typeof o === 'object' && o !== null
    && typeof o.lat === 'number' && Number.isFinite(o.lat) && o.lat >= -90 && o.lat <= 90
    && typeof o.lon === 'number' && Number.isFinite(o.lon) && o.lon >= -180 && o.lon <= 180
}

function parseFence(v: unknown): Geofence {
  const o = v as Record<string, unknown>
  if (typeof o !== 'object' || o === null) throw new Error('Invalid fence: not an object')
  if (o.kind === 'circle') {
    if (!isLatLng(o.centre)) throw new Error('Invalid circle fence: malformed centre')
    if (typeof o.radiusMetres !== 'number' || !Number.isFinite(o.radiusMetres) || o.radiusMetres <= 0) {
      throw new Error('Invalid circle fence: radiusMetres must be a positive number')
    }
    return { kind: 'circle', centre: { lat: o.centre.lat, lon: o.centre.lon }, radiusMetres: o.radiusMetres }
  }
  if (o.kind === 'polygon') {
    if (!Array.isArray(o.vertices) || o.vertices.length < 3 || !o.vertices.every(isLatLng)) {
      throw new Error('Invalid polygon fence: need at least 3 valid vertices')
    }
    return { kind: 'polygon', vertices: o.vertices.map((p) => ({ lat: p.lat, lon: p.lon })) }
  }
  throw new Error('Invalid fence: unknown kind')
}

function validateSet(set: FenceSet): FenceSet {
  if (!HEX_64_RE.test(set.by)) throw new Error('by must be a 64-character lowercase hex pubkey')
  if (typeof set.updatedAt !== 'number' || !Number.isFinite(set.updatedAt)) {
    throw new Error('updatedAt must be a finite number (unix seconds)')
  }
  if (!Array.isArray(set.fences)) throw new Error('fences must be an array')
  if (set.fences.length > MAX_FENCES) throw new Error(`fences must hold at most ${MAX_FENCES} entries`)
  return { fences: set.fences.map(parseFence), updatedAt: set.updatedAt, by: set.by }
}

/**
 * Build an unsigned kind-20078 fence-sync signal carrying the circle's complete
 * safe-place set, encrypted with the group envelope key.
 *
 * @throws {Error} If the set, its clock/author, or any fence is malformed.
 */
export async function buildFencesSignal(params: {
  groupId: string
  seedHex: string
  set: FenceSet
}): Promise<UnsignedEvent> {
  const payload = validateSet(params.set)
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: FENCES_SIGNAL_TYPE, encryptedContent })
}

/**
 * Decrypt and strictly validate a fence-sync payload. Every fence is re-validated
 * on the way in — a malformed set must throw here, never replace a good one and
 * silently disable breach detection.
 */
export async function decryptFences(seedHex: string, content: string): Promise<FenceSet> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid fence set: not valid JSON')
  }
  return validateSet(parsed as FenceSet)
}

/**
 * Latest-wins: should `incoming` replace what this device holds? Newer clock wins;
 * equal clocks tie-break on the lexicographically smaller author so concurrent
 * same-second edits converge to the same winner on every device; an exact echo
 * (same clock, same author) is never "newer", so replays are no-ops.
 */
export function isNewerFenceSet(
  incoming: { updatedAt: number; by: string },
  current?: { fencesUpdatedAt?: number; fencesBy?: string },
): boolean {
  const at = current?.fencesUpdatedAt
  if (at === undefined) return true
  if (incoming.updatedAt !== at) return incoming.updatedAt > at
  const by = current?.fencesBy
  return by !== undefined && incoming.by < by
}
