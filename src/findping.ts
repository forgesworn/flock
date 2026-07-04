/**
 * Remote exact ping ("find my phone") — the ASK.
 *
 * A member asks a lost device for a one-shot exact location. This module builds
 * and reads only the *request*; the *answer* is an ordinary `beacon` (precision
 * 9) so it is indistinguishable on the wire from any other disclosure (FLOCK
 * §6.1). A remotely-triggered disclosure is only legitimate because the owner
 * pre-authorised it on their own device and the phone is flagged lost — those
 * consent gates live in the app (`app/src/findping.ts`), never on the wire.
 *
 * A distinct type (not an overloaded `buzz`): a plain targeted buzz already
 * *rings* a lost phone (Make it ring), and the ask's consent semantics deserve
 * to be explicit and separable. See `docs/plans/2026-07-04-remote-exact-ping.md`.
 *
 * Encrypted with the group envelope key (`deriveGroupKey`), carried as a
 * kind-20078 signal with `t=findreq`, targeted at one member.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for remote-exact-ping requests. */
export const FIND_PING_SIGNAL_TYPE = 'findreq'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A decrypted "find my phone" request. */
export interface FindPing {
  /** Who is asking (64-char hex). */
  from: string
  /** The member whose phone is asked for an exact fix (64-char hex). */
  target: string
  /** Unix seconds. */
  timestamp: number
}

/**
 * Build an unsigned kind-20078 find-ping request, encrypted with the group
 * envelope key.
 *
 * @throws {Error} If `from`/`target` are not valid hex pubkeys.
 */
export async function buildFindPingSignal(params: {
  groupId: string
  seedHex: string
  from: string
  target: string
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (!HEX_64_RE.test(params.target)) throw new Error('target must be a 64-character lowercase hex pubkey')
  const payload: FindPing = {
    from: params.from,
    target: params.target,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: FIND_PING_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a find-ping request's content with the group envelope key. */
export async function decryptFindPing(seedHex: string, content: string): Promise<FindPing> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid find-ping payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) {
    throw new Error('Invalid find-ping: from must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.target !== 'string' || !HEX_64_RE.test(o.target)) {
    throw new Error('Invalid find-ping: target must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid find-ping: timestamp must be a number')
  }
  return { from: o.from, target: o.target, timestamp: o.timestamp }
}
