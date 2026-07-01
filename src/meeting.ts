/**
 * Meeting-point signals — the *where* of Phase F.
 *
 * "Some of us are in one bar, some in another — where do we all go?" A member
 * proposes finding a fair meeting point (a `meeting-request`); each other member
 * may **opt in** and contribute their **coarse** location (a `meeting-share`).
 * The proposer's device then computes a fair midpoint entirely on-device (at the
 * app edge, over `rendezvous-kit`) and turns the chosen point into an ordinary
 * rendezvous — reusing the machinery already built.
 *
 * Both signals ride `canary-kit`'s kind-20078 event, group-envelope encrypted
 * (the same key as rendezvous), distinguished by the `t` tag. Like every flock
 * beacon, a share carries an **already-encoded geohash** + precision — geohash
 * encoding and the coarsening choice stay at the edge; this module never touches
 * raw coordinates. Contributing is voluntary and per-request: declining sends
 * nothing, which is observationally identical to sharing.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'
import type { TravelMode } from './rendezvous.js'

const HEX_64_RE = /^[0-9a-f]{64}$/
const TRAVEL_MODES: readonly TravelMode[] = ['walk', 'cycle', 'drive', 'transit']

/** The `t`-tag for a meeting-point proposal and for a member's coarse contribution. */
export const MEETING_REQUEST_TYPE = 'mtg-req'
export const MEETING_SHARE_TYPE = 'mtg-loc'

/** A proposal to find a fair meeting point for the group. */
export interface MeetingRequest {
  id: string
  /** 64-hex pubkey of the proposer. */
  setBy: string
  /** How the group is travelling (the fairness baseline). */
  mode: TravelMode
  /** Reachability budget for the on-device isochrones, in minutes. */
  maxTimeMinutes: number
  /** Unix seconds. */
  createdAt: number
}

/** One member's opt-in, coarse contribution toward a meeting-point request. */
export interface MeetingShare {
  requestId: string
  /** 64-hex pubkey of the contributor. */
  member: string
  /** Caller-encoded geohash of a **coarse** cell (never an exact fix). */
  geohash: string
  /** Geohash precision (1–11); the coarse default is 6 (~neighbourhood). */
  precision: number
  /** The contributor's travel mode. */
  mode: TravelMode
  /** Unix seconds. */
  timestamp: number
}

function isTravelMode(v: unknown): v is TravelMode {
  return typeof v === 'string' && (TRAVEL_MODES as readonly string[]).includes(v)
}

function validateRequest(o: Record<string, unknown>): MeetingRequest {
  if (typeof o.id !== 'string' || !o.id) throw new Error('Invalid meeting request: id')
  if (typeof o.setBy !== 'string' || !HEX_64_RE.test(o.setBy)) throw new Error('Invalid meeting request: setBy')
  if (!isTravelMode(o.mode)) throw new Error('Invalid meeting request: mode')
  if (typeof o.maxTimeMinutes !== 'number' || !Number.isFinite(o.maxTimeMinutes) || o.maxTimeMinutes <= 0) {
    throw new Error('Invalid meeting request: maxTimeMinutes')
  }
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) throw new Error('Invalid meeting request: createdAt')
  return { id: o.id, setBy: o.setBy, mode: o.mode, maxTimeMinutes: o.maxTimeMinutes, createdAt: o.createdAt }
}

function validateShare(o: Record<string, unknown>): MeetingShare {
  if (typeof o.requestId !== 'string' || !o.requestId) throw new Error('Invalid meeting share: requestId')
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) throw new Error('Invalid meeting share: member')
  if (typeof o.geohash !== 'string' || !o.geohash) throw new Error('Invalid meeting share: geohash')
  if (typeof o.precision !== 'number' || !Number.isInteger(o.precision) || o.precision < 1 || o.precision > 11) {
    throw new Error('Invalid meeting share: precision')
  }
  if (!isTravelMode(o.mode)) throw new Error('Invalid meeting share: mode')
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) throw new Error('Invalid meeting share: timestamp')
  return { requestId: o.requestId, member: o.member, geohash: o.geohash, precision: o.precision, mode: o.mode, timestamp: o.timestamp }
}

/** Build an unsigned kind-20078 meeting-request signal (group-envelope encrypted). */
export async function buildMeetingRequestSignal(params: { groupId: string; seedHex: string; request: MeetingRequest }): Promise<UnsignedEvent> {
  validateRequest(params.request as unknown as Record<string, unknown>)
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(params.request))
  return buildSignalEvent({ groupId: params.groupId, signalType: MEETING_REQUEST_TYPE, encryptedContent })
}

/** Decrypt a meeting-request signal. */
export async function decryptMeetingRequest(seedHex: string, content: string): Promise<MeetingRequest> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  return validateRequest(JSON.parse(plaintext) as Record<string, unknown>)
}

/** Build an unsigned kind-20078 meeting-share signal (group-envelope encrypted). */
export async function buildMeetingShareSignal(params: { groupId: string; seedHex: string; share: MeetingShare }): Promise<UnsignedEvent> {
  validateShare(params.share as unknown as Record<string, unknown>)
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(params.share))
  return buildSignalEvent({ groupId: params.groupId, signalType: MEETING_SHARE_TYPE, encryptedContent })
}

/** Decrypt a meeting-share signal. */
export async function decryptMeetingShare(seedHex: string, content: string): Promise<MeetingShare> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  return validateShare(JSON.parse(plaintext) as Record<string, unknown>)
}

/**
 * Parse + validate a MeetingShare from an untrusted, already-decrypted object —
 * non-throwing (returns null on any malformation). The coarse group-inbox path uses
 * {@link decryptMeetingShare} (which validates as it decrypts); this is for an
 * **exact** share that arrived gift-wrapped to a member's personal inbox, where the
 * transport already decrypted the payload and only shape-validation remains.
 */
export function parseMeetingShare(o: unknown): MeetingShare | null {
  try {
    return validateShare(o as Record<string, unknown>)
  } catch {
    return null
  }
}
