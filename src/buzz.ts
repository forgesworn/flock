/**
 * Buzz — a one-tap ping to the circle with a chosen meaning.
 *
 * The friendly counterpart to `help`: a parent buzzes a child "come home", or
 * any member nudges the group. A buzz carries a free-text `reason` (preset or
 * custom — adults can assign their own) and an optional `target` member it's
 * aimed at (others still see it, the target's phone buzzes hardest).
 *
 * Encrypted with the group envelope key (`deriveGroupKey`), carried as a
 * kind-20078 signal with `t=buzz`.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for buzz signals. */
export const BUZZ_SIGNAL_TYPE = 'buzz'

/** Sensible default reasons; a circle can add its own. */
export const DEFAULT_BUZZ_REASONS = [
  'Come home',
  'Check in',
  'Where are you?',
  'Call me',
  'On my way',
] as const

const HEX_64_RE = /^[0-9a-f]{64}$/
const MAX_REASON = 280

/** A decrypted buzz. */
export interface Buzz {
  /** Sender pubkey (64-char hex). */
  from: string
  /** Free-text reason (preset or custom). */
  reason: string
  /** Optional recipient the buzz is aimed at (64-char hex); absent = whole circle. */
  target?: string
  /** Unix seconds. */
  timestamp: number
  /**
   * Optional ask riding the buzz. `'location'` = a roll-call: the sender is
   * asking members to report where they are. Receivers decide FOR THEMSELVES
   * how (or whether) to answer — an ask is never an automatic disclosure.
   * Older clients ignore the field and show the buzz text as normal.
   */
  ask?: 'location'
}

function validateReason(reason: string): string {
  const r = (reason ?? '').trim()
  if (!r) throw new Error('buzz reason must be a non-empty string')
  if (r.length > MAX_REASON) throw new Error(`buzz reason must be at most ${MAX_REASON} characters`)
  return r
}

/**
 * Build an unsigned kind-20078 buzz signal, encrypted with the group envelope key.
 *
 * @throws {Error} If `from`/`target` are not valid hex pubkeys or `reason` is empty/too long.
 */
export async function buildBuzzSignal(params: {
  groupId: string
  seedHex: string
  from: string
  reason: string
  target?: string
  timestamp?: number
  ask?: 'location'
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (params.target !== undefined && !HEX_64_RE.test(params.target)) {
    throw new Error('target must be a 64-character lowercase hex pubkey')
  }
  if (params.ask !== undefined && params.ask !== 'location') {
    throw new Error("ask must be 'location' when present")
  }
  const reason = validateReason(params.reason)
  const payload: Buzz = {
    from: params.from,
    reason,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.target !== undefined && { target: params.target }),
    ...(params.ask !== undefined && { ask: params.ask }),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: BUZZ_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a buzz signal's content with the group envelope key. */
export async function decryptBuzz(seedHex: string, content: string): Promise<Buzz> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid buzz payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) {
    throw new Error('Invalid buzz: from must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.reason !== 'string' || o.reason.trim().length === 0 || o.reason.length > MAX_REASON) {
    throw new Error('Invalid buzz: reason missing or malformed')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid buzz: timestamp must be a number')
  }
  if (o.target !== undefined && (typeof o.target !== 'string' || !HEX_64_RE.test(o.target))) {
    throw new Error('Invalid buzz: target must be a 64-character lowercase hex pubkey')
  }
  return {
    from: o.from,
    reason: o.reason,
    timestamp: o.timestamp,
    ...(typeof o.target === 'string' && { target: o.target }),
    // Unknown ask values are DROPPED, not fatal — a future ask kind must not
    // make today's client throw away the human-readable buzz that carries it.
    ...(o.ask === 'location' && { ask: 'location' as const }),
  }
}
