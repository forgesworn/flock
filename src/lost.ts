/**
 * Lost phone — a peer-set flag that a member's device is out of their hands
 * (left in a taxi, dropped on a night out).
 *
 * Anyone in the circle can report any member's phone lost, and anyone can
 * clear it ("found it") — including the owner from the phone itself. It is a
 * social coordination flag, not a security control: it changes what screens
 * SHOW (a flagged roster row, an alert-coloured pin, a message for whoever
 * finds the phone), never what a device DISCLOSES. A lost report must not —
 * and cannot — start sharing, raise precision, or move any location data.
 *
 * Encrypted with the group envelope key (`deriveGroupKey`), carried as a
 * kind-20078 signal with `t=lost`. Latest report per member wins (by its
 * inner timestamp), so mark/clear converge on every device in any order.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for lost-phone signals. */
export const LOST_SIGNAL_TYPE = 'lost'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A decrypted lost-phone report (or its all-clear). */
export interface LostReport {
  /** The member whose phone is reported lost (64-char hex). */
  member: string
  /** Who filed the report or the all-clear (64-char hex). */
  by: string
  /** true = reported lost; false = found / not lost after all. */
  lost: boolean
  /** Unix seconds — latest report per member wins. */
  timestamp: number
}

/**
 * Build an unsigned kind-20078 lost-phone signal, encrypted with the group
 * envelope key.
 *
 * @throws {Error} If `member`/`by` are not valid hex pubkeys.
 */
export async function buildLostSignal(params: {
  groupId: string
  seedHex: string
  member: string
  by: string
  lost: boolean
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) throw new Error('member must be a 64-character lowercase hex pubkey')
  if (!HEX_64_RE.test(params.by)) throw new Error('by must be a 64-character lowercase hex pubkey')
  const payload: LostReport = {
    member: params.member,
    by: params.by,
    lost: params.lost,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: LOST_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a lost-phone signal's content with the group envelope key. */
export async function decryptLost(seedHex: string, content: string): Promise<LostReport> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid lost payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid lost report: member must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.by !== 'string' || !HEX_64_RE.test(o.by)) {
    throw new Error('Invalid lost report: by must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.lost !== 'boolean') {
    throw new Error('Invalid lost report: lost must be a boolean')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid lost report: timestamp must be a number')
  }
  return { member: o.member, by: o.by, lost: o.lost, timestamp: o.timestamp }
}
