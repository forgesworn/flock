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

/** A decrypted joined announcement. */
export interface Joined {
  /** The newcomer's pubkey (64-char hex) — must match the signal's sender. */
  member: string
  /** Unix seconds. */
  timestamp: number
}

/**
 * Build an unsigned kind-20078 joined signal, encrypted with the group envelope key.
 *
 * @throws {Error} If `member` is not a valid hex pubkey.
 */
export async function buildJoinedSignal(params: {
  groupId: string
  seedHex: string
  member: string
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) throw new Error('member must be a 64-character lowercase hex pubkey')
  const payload: Joined = { member: params.member, timestamp: params.timestamp ?? Math.floor(Date.now() / 1000) }
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
  return { member: o.member, timestamp: o.timestamp }
}
