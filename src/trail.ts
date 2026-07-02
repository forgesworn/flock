/**
 * Pre-SOS breadcrumb trail for flock.
 *
 * A help/breach signal carries one point-in-time fix — not enough to find
 * someone who kept moving after the trigger. The device keeps a short rolling
 * buffer of recent fixes **on-device only** (memory, never persisted, never
 * transmitted) and disclosure happens exclusively *after* a serious trigger:
 * the buffer rides along as a `trail` signal, encrypted with the **duress
 * key** — trail data exists only because a help/breach fired, so it lives in
 * the duress domain, never the beacon domain (FLOCK §6 invariant 3).
 *
 * The buffer maths (`pushCrumb`) is pure: spacing, age and size limits are
 * enforced on every push, so the caller can feed it raw fixes and the buffer
 * stays small and recent. Geohash encoding stays at the edge, as everywhere.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveDuressKey } from 'canary-kit'
import { encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for trail signals (kind 20078). */
export const TRAIL_SIGNAL_TYPE = 'trail'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** One recorded fix in the rolling buffer. */
export interface Breadcrumb {
  /** Caller-encoded geohash (e.g. via geohash-kit `encode`). */
  geohash: string
  /** Geohash precision, 1–11. */
  precision: number
  /** Unix seconds the fix was taken. */
  timestamp: number
}

/** A disclosed trail: the crumbs that preceded a help/breach trigger. */
export interface Trail {
  /** 64-char lowercase hex pubkey of the member the trail belongs to. */
  member: string
  /** Which trigger disclosed it. */
  reason: 'help' | 'breach'
  /** Oldest-first recent fixes. */
  crumbs: Breadcrumb[]
  /** Unix seconds the trail was disclosed. */
  timestamp: number
}

/** Most crumbs a buffer (and a trail signal) may hold. */
export const DEFAULT_TRAIL_MAX_CRUMBS = 12

/** Crumbs older than this (relative to the newest) are dropped. */
export const DEFAULT_TRAIL_MAX_AGE_SECONDS = 900

/** Minimum seconds between recorded crumbs (denser fixes are skipped). */
export const DEFAULT_TRAIL_MIN_SPACING_SECONDS = 60

function validateCrumb(c: Breadcrumb, label: string): void {
  if (!c || typeof c.geohash !== 'string' || c.geohash.length === 0) {
    throw new Error(`Invalid ${label}: geohash must be a non-empty string`)
  }
  if (!Number.isInteger(c.precision) || c.precision < 1 || c.precision > 11) {
    throw new Error(`Invalid ${label}: precision must be an integer between 1 and 11`)
  }
  if (typeof c.timestamp !== 'number' || !Number.isFinite(c.timestamp)) {
    throw new Error(`Invalid ${label}: timestamp must be a number`)
  }
}

/**
 * Push a fix into the rolling buffer. Returns a NEW buffer (never mutates);
 * returns the original when the crumb is skipped (inside the spacing window,
 * or older than the newest crumb). Age and size limits are enforced on every
 * push, so the buffer can never grow beyond `maxCrumbs` or hold anything
 * older than `maxAgeSeconds` behind its newest entry.
 *
 * @throws {Error} If the crumb or any option is malformed.
 */
export function pushCrumb(
  crumbs: Breadcrumb[],
  crumb: Breadcrumb,
  opts?: { maxCrumbs?: number; maxAgeSeconds?: number; minSpacingSeconds?: number },
): Breadcrumb[] {
  validateCrumb(crumb, 'crumb')
  const maxCrumbs = opts?.maxCrumbs ?? DEFAULT_TRAIL_MAX_CRUMBS
  const maxAge = opts?.maxAgeSeconds ?? DEFAULT_TRAIL_MAX_AGE_SECONDS
  const spacing = opts?.minSpacingSeconds ?? DEFAULT_TRAIL_MIN_SPACING_SECONDS
  if (!Number.isInteger(maxCrumbs) || maxCrumbs <= 0) throw new Error('maxCrumbs must be a positive integer')
  if (!Number.isInteger(maxAge) || maxAge <= 0) throw new Error('maxAgeSeconds must be a positive integer')
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error('minSpacingSeconds must be a positive integer')

  const last = crumbs[crumbs.length - 1]
  if (last && crumb.timestamp - last.timestamp < spacing) return crumbs

  return [...crumbs, crumb]
    .filter((c) => crumb.timestamp - c.timestamp <= maxAge)
    .slice(-maxCrumbs)
}

/**
 * Build an unsigned kind-20078 trail signal, encrypting the crumbs with the
 * group's **duress key** — recipients read it with the same key they already
 * use for `help` alerts; it is never decryptable via the beacon or envelope
 * keys.
 *
 * @throws {Error} If any param is malformed, the trail is empty, or it holds
 *   more than `DEFAULT_TRAIL_MAX_CRUMBS` crumbs.
 */
export async function buildTrailSignal(params: {
  groupId: string
  seedHex: string
  member: string
  reason: 'help' | 'breach'
  crumbs: Breadcrumb[]
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) throw new Error('member must be a 64-character lowercase hex pubkey')
  if (params.reason !== 'help' && params.reason !== 'breach') throw new Error("reason must be 'help' or 'breach'")
  if (!Array.isArray(params.crumbs) || params.crumbs.length === 0) throw new Error('crumbs must be a non-empty array')
  if (params.crumbs.length > DEFAULT_TRAIL_MAX_CRUMBS) {
    throw new Error(`crumbs must hold at most ${DEFAULT_TRAIL_MAX_CRUMBS} entries`)
  }
  params.crumbs.forEach((c, i) => validateCrumb(c, `crumbs[${i}]`))

  const payload: Trail = {
    member: params.member,
    reason: params.reason,
    crumbs: params.crumbs,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
  }
  const encryptedContent = await encryptEnvelope(deriveDuressKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: TRAIL_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a trail signal's content with the group duress key. */
export async function decryptTrail(seedHex: string, content: string): Promise<Trail> {
  const plaintext = await decryptEnvelope(deriveDuressKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid trail payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid trail: member must be a 64-character lowercase hex pubkey')
  }
  if (o.reason !== 'help' && o.reason !== 'breach') {
    throw new Error("Invalid trail: reason must be 'help' or 'breach'")
  }
  if (!Array.isArray(o.crumbs) || o.crumbs.length === 0 || o.crumbs.length > DEFAULT_TRAIL_MAX_CRUMBS) {
    throw new Error(`Invalid trail: crumbs must be a non-empty array of at most ${DEFAULT_TRAIL_MAX_CRUMBS}`)
  }
  o.crumbs.forEach((c, i) => validateCrumb(c as Breadcrumb, `crumbs[${i}]`))
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid trail: timestamp must be a number')
  }
  return {
    member: o.member,
    reason: o.reason,
    crumbs: (o.crumbs as Breadcrumb[]).map((c) => ({ geohash: c.geohash, precision: c.precision, timestamp: c.timestamp })),
    timestamp: o.timestamp,
  }
}
