/**
 * Check-in / dead-man's-switch for flock.
 *
 * A member periodically broadcasts an encrypted "I'm OK" check-in carrying the
 * cadence at which the next one is expected. Every other device classifies each
 * member as `ok`, `overdue`, or `missed` — a **missed** check-in is the
 * dead-man's-switch firing (absence of action raises the alarm).
 *
 * The classifier is pure and takes `now` explicitly (deterministic, testable).
 * Encryption reuses canary-kit's group envelope (`deriveGroupKey` +
 * `encryptEnvelope`), whose key is domain-separated from beacon/duress keys.
 *
 * A member stands down by sending a final check-in with `intervalSeconds <= 0`
 * (no longer expected to check in — never alarms).
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for check-in signals (kind 20078). */
export const CHECKIN_SIGNAL_TYPE = 'checkin'

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A decrypted check-in. */
export interface CheckIn {
  /** 64-char lowercase hex pubkey of the member checking in. */
  member: string
  /** Unix seconds of this check-in. */
  timestamp: number
  /** Expected cadence in seconds; `<= 0` means stood down (no longer monitored). */
  intervalSeconds: number
}

export type CheckInStatus = 'ok' | 'overdue' | 'missed'

/** A member's check-in status, derived from their latest check-in. */
export interface CheckInState {
  member: string
  status: CheckInStatus
  /** Timestamp of the latest check-in. */
  lastCheckIn: number
  /** When the next check-in is due (`Infinity` if stood down). */
  dueAt: number
  /** `now - lastCheckIn`, in seconds. */
  ageSeconds: number
}

/** Grace after `dueAt` before a check-in is `missed` (the alarm). */
export const DEFAULT_GRACE_SECONDS = 300

/**
 * Classify each member's check-in status from their check-ins. Collapses to the
 * latest per member; sorts most-at-risk first.
 *
 * @throws {Error} If `graceSeconds` is negative or not an integer.
 */
export function classifyCheckins(
  checkins: CheckIn[],
  now: number,
  opts?: { graceSeconds?: number },
): CheckInState[] {
  const grace = opts?.graceSeconds ?? DEFAULT_GRACE_SECONDS
  if (!Number.isInteger(grace) || grace < 0) {
    throw new Error('graceSeconds must be a non-negative integer')
  }

  const latest = new Map<string, CheckIn>()
  for (const c of checkins) {
    const prev = latest.get(c.member)
    if (!prev || c.timestamp > prev.timestamp) latest.set(c.member, c)
  }

  const out: CheckInState[] = []
  for (const c of latest.values()) {
    const dueAt = c.intervalSeconds > 0 ? c.timestamp + c.intervalSeconds : Number.POSITIVE_INFINITY
    let status: CheckInStatus = 'ok'
    if (Number.isFinite(dueAt)) {
      if (now > dueAt + grace) status = 'missed'
      else if (now > dueAt) status = 'overdue'
    }
    out.push({ member: c.member, status, lastCheckIn: c.timestamp, dueAt, ageSeconds: now - c.timestamp })
  }
  out.sort((a, b) => a.dueAt - b.dueAt)
  return out
}

/** The members whose check-in has been missed (dead-man's-switch fired). */
export function missedCheckins(states: CheckInState[]): CheckInState[] {
  return states.filter((s) => s.status === 'missed')
}

function validateCheckIn(o: Record<string, unknown>): CheckIn {
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid check-in: member must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid check-in: timestamp must be a number')
  }
  if (typeof o.intervalSeconds !== 'number' || !Number.isFinite(o.intervalSeconds)) {
    throw new Error('Invalid check-in: intervalSeconds must be a number')
  }
  return { member: o.member, timestamp: o.timestamp, intervalSeconds: o.intervalSeconds }
}

/**
 * Build an unsigned kind-20078 check-in signal, encrypting the payload with the
 * group envelope key. Pass `intervalSeconds <= 0` to stand down.
 */
export async function buildCheckInSignal(params: {
  groupId: string
  seedHex: string
  member: string
  intervalSeconds: number
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) {
    throw new Error('member must be a 64-character lowercase hex pubkey')
  }
  const payload: CheckIn = {
    member: params.member,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    intervalSeconds: params.intervalSeconds,
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: CHECKIN_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt a check-in signal's content with the group envelope key. */
export async function decryptCheckIn(seedHex: string, content: string): Promise<CheckIn> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid check-in payload: not valid JSON')
  }
  return validateCheckIn(parsed as Record<string, unknown>)
}
