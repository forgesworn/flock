/**
 * Joined — the "I'm here" a newcomer announces to the circle.
 *
 * Joining by QR/link is entirely local: the newcomer holds the seed, but no
 * other member learns they exist until their first signal. This announcement
 * IS that first signal — location-free, carrying nothing beyond what seed
 * possession already implies — so every member's roster (and the FLOCK §6
 * "new phone joined" notice) updates at join time, not at first use.
 *
 * Encrypted with the group envelope key (`deriveGroupKey`), carried as a
 * kind-20078 signal with `t=joined`.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for joined signals. */
export const JOINED_SIGNAL_TYPE = 'joined'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** Handles are for recognition, not essays. */
export const MAX_HANDLE = 40

/** A decrypted joined announcement. */
export interface Joined {
  /** The newcomer's pubkey (64-char hex) — must match the signal's sender. */
  member: string
  /** Unix seconds. */
  timestamp: number
  /** Self-chosen display handle ("Dave") — a SUGGESTION for other members'
   *  private nicknames, never an authenticated identity. Travels only inside
   *  this encrypted payload; the relay never sees it. */
  handle?: string
}

/**
 * Build an unsigned kind-20078 joined signal, encrypted with the group envelope key.
 *
 * @throws {Error} If `member` is not a valid hex pubkey, or `handle` exceeds MAX_HANDLE.
 */
export async function buildJoinedSignal(params: {
  groupId: string
  seedHex: string
  member: string
  timestamp?: number
  handle?: string
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) throw new Error('member must be a 64-character lowercase hex pubkey')
  const handle = params.handle?.trim()
  if (handle !== undefined && handle.length > MAX_HANDLE) throw new Error(`handle must be at most ${MAX_HANDLE} characters`)
  const payload: Joined = {
    member: params.member,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(handle ? { handle } : {}),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: JOINED_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a joined signal's content with the group envelope key. */
export async function decryptJoined(seedHex: string, content: string): Promise<Joined> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid joined payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid joined: member must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid joined: timestamp must be a number')
  }
  // A malformed handle is dropped rather than fatal — the announcement itself
  // (roster membership) must not hinge on a cosmetic field.
  const handle = typeof o.handle === 'string' && o.handle.trim() && o.handle.trim().length <= MAX_HANDLE
    ? o.handle.trim()
    : undefined
  return { member: o.member, timestamp: o.timestamp, ...(handle ? { handle } : {}) }
}
