/**
 * All-clear — stand down a help alert ("I'm safe now").
 *
 * The missing half of `help`: an accidental SOS (or a resolved one) needs a way
 * to tell the circle it's over. A genuine all-clear clears the member's alert on
 * every device.
 *
 * The coercion case is first-class (FLOCK §6): "tell them you're fine" is
 * exactly what a coercer demands. A `coerced` all-clear looks identical on the
 * wire and on the sending screen — but receivers IGNORE it, so the circle stays
 * alarmed. The flag lives inside the encryption; the relay (and anyone watching
 * the device's traffic) sees only another opaque signal.
 *
 * Encrypted with the group envelope key (`deriveGroupKey`), carried as a
 * kind-20078 signal with `t=allclear`.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for all-clear signals. */
export const ALLCLEAR_SIGNAL_TYPE = 'allclear'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A decrypted all-clear. */
export interface AllClear {
  /** Whose alert this stands down (64-char hex) — always the sender's own. */
  member: string
  /** Unix seconds. */
  timestamp: number
  /** Coerced stand-down: receivers keep the alarm live. Absent = genuine. */
  coerced?: boolean
}

/**
 * Build an unsigned kind-20078 all-clear signal, encrypted with the group
 * envelope key.
 *
 * @throws {Error} If `member` is not a valid hex pubkey.
 */
export async function buildAllClearSignal(params: {
  groupId: string
  seedHex: string
  member: string
  timestamp?: number
  coerced?: boolean
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) throw new Error('member must be a 64-character lowercase hex pubkey')
  const payload: AllClear = {
    member: params.member,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.coerced === true && { coerced: true }),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: ALLCLEAR_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt an all-clear signal's content with the group envelope key. */
export async function decryptAllClear(seedHex: string, content: string): Promise<AllClear> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid all-clear payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid all-clear: member must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid all-clear: timestamp must be a number')
  }
  if (o.coerced !== undefined && typeof o.coerced !== 'boolean') {
    throw new Error('Invalid all-clear: coerced must be a boolean when present')
  }
  return {
    member: o.member,
    timestamp: o.timestamp,
    ...(o.coerced === true && { coerced: true }),
  }
}
