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
  /** When the miss fires: `dueAt + grace` (`Infinity` if stood down). */
  missedAt: number
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
    const missedAt = dueAt + grace
    let status: CheckInStatus = 'ok'
    if (Number.isFinite(dueAt)) {
      if (now > missedAt) status = 'missed'
      else if (now > dueAt) status = 'overdue'
    }
    out.push({ member: c.member, status, lastCheckIn: c.timestamp, dueAt, missedAt, ageSeconds: now - c.timestamp })
  }
  out.sort((a, b) => a.dueAt - b.dueAt)
  return out
}

/** The members whose check-in has been missed (dead-man's-switch fired). */
export function missedCheckins(states: CheckInState[]): CheckInState[] {
  return states.filter((s) => s.status === 'missed')
}

// ── Self-reminder: nudge the user before their own check-in goes overdue ─────

/**
 * The user's own check-in standing. Unlike watcher-side classification, this
 * exists so the app can prompt *before* the deadline — a reminder must stay
 * entirely local (no traffic; a nudge that emitted anything would be a tell).
 */
export type SelfCheckInStatus = 'none' | 'ok' | 'due-soon' | 'overdue' | 'missed'

/** How long before `dueAt` the "check in now" nudge window opens. */
export const DEFAULT_REMIND_BEFORE_SECONDS = 600

/**
 * Classify the user's own latest check-in against their deadline. `due-soon`
 * opens `remindBeforeSeconds` before `dueAt` (a `remindBeforeSeconds` larger
 * than the cadence simply keeps the window open from the start); `missed`
 * means the circle is already alarmed.
 *
 * @throws {Error} If `remindBeforeSeconds` is not a positive integer, or
 *   `graceSeconds` is negative.
 */
export function selfCheckInStatus(
  mine: CheckIn | null,
  now: number,
  opts?: { remindBeforeSeconds?: number; graceSeconds?: number },
): SelfCheckInStatus {
  const remindBefore = opts?.remindBeforeSeconds ?? DEFAULT_REMIND_BEFORE_SECONDS
  if (!Number.isInteger(remindBefore) || remindBefore <= 0) {
    throw new Error('remindBeforeSeconds must be a positive integer')
  }
  if (!mine || mine.intervalSeconds <= 0) return 'none'

  const [state] = classifyCheckins([mine], now, opts?.graceSeconds !== undefined ? { graceSeconds: opts.graceSeconds } : undefined)
  if (state.status !== 'ok') return state.status
  return now > state.dueAt - remindBefore ? 'due-soon' : 'ok'
}

// ── Acknowledgement: "I've got this" for a missed check-in ───────────────────

/** The `t`-tag value for check-in acknowledgement signals (kind 20078). */
export const ACK_SIGNAL_TYPE = 'ack'

/** A decrypted acknowledgement of a missed check-in. */
export interface CheckInAck {
  /** 64-char lowercase hex pubkey of the responder. */
  member: string
  /** 64-char lowercase hex pubkey of the member whose miss is being handled. */
  target: string
  /** Unix seconds. */
  timestamp: number
}

/**
 * Build an unsigned kind-20078 acknowledgement signal ("I'm responding to
 * `target`'s missed check-in"), encrypted with the group envelope key. Other
 * watchers stand their repeat alerts down — escalation stays peer-to-peer.
 *
 * @throws {Error} If `member`/`target` are not valid hex pubkeys, or equal.
 */
export async function buildAckSignal(params: {
  groupId: string
  seedHex: string
  member: string
  target: string
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.member)) throw new Error('member must be a 64-character lowercase hex pubkey')
  if (!HEX_64_RE.test(params.target)) throw new Error('target must be a 64-character lowercase hex pubkey')
  if (params.member === params.target) throw new Error('cannot acknowledge your own missed check-in — check in instead')
  const payload: CheckInAck = {
    member: params.member,
    target: params.target,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: ACK_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt an acknowledgement signal's content with the group envelope key. */
export async function decryptAck(seedHex: string, content: string): Promise<CheckInAck> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid ack payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.member !== 'string' || !HEX_64_RE.test(o.member)) {
    throw new Error('Invalid ack: member must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.target !== 'string' || !HEX_64_RE.test(o.target)) {
    throw new Error('Invalid ack: target must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid ack: timestamp must be a number')
  }
  return { member: o.member, target: o.target, timestamp: o.timestamp }
}

// ── Escalation: repeat-alert until somebody acknowledges ─────────────────────

/** 0 = just missed · 1 = repeat alert · 2 = all-hands. */
export type EscalationLevel = 0 | 1 | 2

/** Seconds between escalation levels. */
export const DEFAULT_ESCALATION_STEP_SECONDS = 600

/** A missed member's escalation standing. */
export interface EscalationState {
  /** The member whose check-in was missed. */
  member: string
  status: 'unacknowledged' | 'acknowledged'
  /** Severity by time since the miss fired (rises regardless of acks). */
  level: EscalationLevel
  /** When the miss fired (`dueAt + grace`). */
  missedAt: number
  /** First responder, when acknowledged. */
  acknowledgedBy?: string
  acknowledgedAt?: number
}

/**
 * Compute the escalation standing of every missed member. An ack counts only
 * if it is newer than the member's latest check-in — an ack from a previous
 * miss (already resolved by that check-in) never silences a new one. The
 * earliest qualifying ack wins ("first responder"). Sorted unacknowledged
 * first, then longest-missed first.
 *
 * @throws {Error} If `stepSeconds` is not a positive integer.
 */
export function classifyEscalation(
  states: CheckInState[],
  acks: CheckInAck[],
  now: number,
  opts?: { stepSeconds?: number },
): EscalationState[] {
  const step = opts?.stepSeconds ?? DEFAULT_ESCALATION_STEP_SECONDS
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error('stepSeconds must be a positive integer')
  }

  const out: EscalationState[] = []
  for (const s of missedCheckins(states)) {
    let first: CheckInAck | null = null
    for (const a of acks) {
      if (a.target !== s.member || a.timestamp <= s.lastCheckIn) continue
      if (!first || a.timestamp < first.timestamp) first = a
    }
    const level = Math.min(2, Math.max(0, Math.floor((now - s.missedAt) / step))) as EscalationLevel
    out.push({
      member: s.member,
      status: first ? 'acknowledged' : 'unacknowledged',
      level,
      missedAt: s.missedAt,
      ...(first && { acknowledgedBy: first.member, acknowledgedAt: first.timestamp }),
    })
  }
  out.sort((a, b) =>
    a.status !== b.status ? (a.status === 'unacknowledged' ? -1 : 1) : a.missedAt - b.missedAt,
  )
  return out
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
