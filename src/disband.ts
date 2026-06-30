/**
 * Disband — tombstone a circle for *everyone*.
 *
 * One member broadcasts a disband signal (gift-wrapped to the circle inbox like
 * every other signal); each member's app then drops the circle and wipes its
 * seed. This is the *transport* complement to canary-kit's `dissolveGroup`
 * (which zeroes a `GroupState` locally) — here we also tell the others, over the
 * same metadata-free channel (the relay sees only an opaque `kind:1059`).
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

export const DISBAND_SIGNAL_TYPE = 'disband'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A disband tombstone for a circle. */
export interface Disband {
  /** Circle id being disbanded. */
  groupId: string
  /** 64-hex pubkey of whoever disbanded it. */
  by: string
  /** Optional human reason. */
  reason?: string
  /** Unix seconds. */
  timestamp: number
}

/** Build an unsigned kind-20078 disband signal (group-envelope encrypted). */
export async function buildDisbandSignal(params: {
  groupId: string
  seedHex: string
  by: string
  reason?: string
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.by)) throw new Error('by must be a 64-hex pubkey')
  const payload: Disband = {
    groupId: params.groupId,
    by: params.by,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.reason ? { reason: params.reason } : {}),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: DISBAND_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a disband signal. */
export async function decryptDisband(seedHex: string, content: string): Promise<Disband> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  const o = JSON.parse(plaintext) as Record<string, unknown>
  if (typeof o.groupId !== 'string' || !o.groupId) throw new Error('Invalid disband: groupId')
  if (typeof o.by !== 'string' || !HEX_64_RE.test(o.by)) throw new Error('Invalid disband: by')
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) throw new Error('Invalid disband: timestamp')
  return {
    groupId: o.groupId,
    by: o.by,
    timestamp: o.timestamp,
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
  }
}
