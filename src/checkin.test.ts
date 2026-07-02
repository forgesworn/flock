import { describe, it, expect } from 'vitest'
import {
  classifyCheckins,
  missedCheckins,
  buildCheckInSignal,
  decryptCheckIn,
  selfCheckInStatus,
  buildAckSignal,
  decryptAck,
  classifyEscalation,
  CHECKIN_SIGNAL_TYPE,
  ACK_SIGNAL_TYPE,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_REMIND_BEFORE_SECONDS,
  DEFAULT_ESCALATION_STEP_SECONDS,
  type CheckIn,
  type CheckInAck,
} from './checkin.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

describe('classifyCheckins', () => {
  const now = 100_000
  const interval = 1800 // 30 min

  it('marks a fresh check-in ok', () => {
    const states = classifyCheckins([{ member: A, timestamp: now - 60, intervalSeconds: interval }], now)
    expect(states[0].status).toBe('ok')
  })

  it('marks a check-in past its due time (within grace) overdue', () => {
    const ts = now - interval - 60 // 60s past due, within 300s grace
    const states = classifyCheckins([{ member: A, timestamp: ts, intervalSeconds: interval }], now)
    expect(states[0].status).toBe('overdue')
  })

  it('marks a check-in past due + grace as missed (dead-man fired)', () => {
    const ts = now - interval - DEFAULT_GRACE_SECONDS - 60
    const states = classifyCheckins([{ member: A, timestamp: ts, intervalSeconds: interval }], now)
    expect(states[0].status).toBe('missed')
  })

  it('treats intervalSeconds <= 0 as stood down (never alarms)', () => {
    const states = classifyCheckins([{ member: A, timestamp: now - 999_999, intervalSeconds: 0 }], now)
    expect(states[0].status).toBe('ok')
    expect(states[0].dueAt).toBe(Number.POSITIVE_INFINITY)
  })

  it('collapses to the latest check-in per member', () => {
    const states = classifyCheckins([
      { member: A, timestamp: now - 5000, intervalSeconds: interval },
      { member: A, timestamp: now - 30, intervalSeconds: interval },
    ], now)
    expect(states).toHaveLength(1)
    expect(states[0].lastCheckIn).toBe(now - 30)
    expect(states[0].status).toBe('ok')
  })

  it('sorts most-at-risk first', () => {
    const states = classifyCheckins([
      { member: A, timestamp: now - 30, intervalSeconds: interval },                 // ok, due latest
      { member: B, timestamp: now - interval - 1000, intervalSeconds: interval },    // missed, due earliest
    ], now)
    expect(states[0].member).toBe(B)
  })

  it('rejects a negative grace', () => {
    expect(() => classifyCheckins([], now, { graceSeconds: -1 })).toThrow()
  })
})

describe('missedCheckins', () => {
  it('returns only the missed members', () => {
    const now = 100_000
    const states = classifyCheckins([
      { member: A, timestamp: now - 30, intervalSeconds: 1800 },
      { member: C, timestamp: now - 100_000, intervalSeconds: 1800 },
    ], now)
    expect(missedCheckins(states).map((s) => s.member)).toEqual([C])
  })
})

describe('buildCheckInSignal / decryptCheckIn', () => {
  it('round-trips a check-in through the group envelope', async () => {
    const event = await buildCheckInSignal({ groupId: 'g', seedHex: SEED, member: A, intervalSeconds: 1800, timestamp: 12_345 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(CHECKIN_SIGNAL_TYPE)

    const back = await decryptCheckIn(SEED, event.content)
    expect(back).toEqual<CheckIn>({ member: A, timestamp: 12_345, intervalSeconds: 1800 })
  })

  it('a wrong seed cannot decrypt the check-in', async () => {
    const event = await buildCheckInSignal({ groupId: 'g', seedHex: SEED, member: A, intervalSeconds: 1800 })
    const wrong = 'f'.repeat(64)
    await expect(decryptCheckIn(wrong, event.content)).rejects.toThrow()
  })

  it('rejects a malformed member', async () => {
    await expect(buildCheckInSignal({ groupId: 'g', seedHex: SEED, member: 'nope', intervalSeconds: 1800 })).rejects.toThrow()
  })
})

describe('classifyCheckins — missedAt', () => {
  const now = 100_000
  const interval = 1800

  it('exposes missedAt = dueAt + grace', () => {
    const ts = now - 60
    const states = classifyCheckins([{ member: A, timestamp: ts, intervalSeconds: interval }], now)
    expect(states[0].missedAt).toBe(ts + interval + DEFAULT_GRACE_SECONDS)
  })

  it('missedAt is Infinity when stood down', () => {
    const states = classifyCheckins([{ member: A, timestamp: now, intervalSeconds: 0 }], now)
    expect(states[0].missedAt).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('selfCheckInStatus', () => {
  const now = 100_000
  const interval = 1800

  it('is none with no check-in armed', () => {
    expect(selfCheckInStatus(null, now)).toBe('none')
  })

  it('is none when stood down (interval <= 0)', () => {
    expect(selfCheckInStatus({ member: A, timestamp: now - 50, intervalSeconds: 0 }, now)).toBe('none')
  })

  it('is ok well before the reminder window', () => {
    const mine: CheckIn = { member: A, timestamp: now - 60, intervalSeconds: interval }
    expect(selfCheckInStatus(mine, now)).toBe('ok')
  })

  it('is due-soon inside the reminder window before dueAt', () => {
    // dueAt = timestamp + interval; window opens remindBefore earlier
    const mine: CheckIn = { member: A, timestamp: now - interval + DEFAULT_REMIND_BEFORE_SECONDS - 60, intervalSeconds: interval }
    expect(selfCheckInStatus(mine, now)).toBe('due-soon')
  })

  it('is overdue past dueAt but within grace', () => {
    const mine: CheckIn = { member: A, timestamp: now - interval - 60, intervalSeconds: interval }
    expect(selfCheckInStatus(mine, now)).toBe('overdue')
  })

  it('is missed past dueAt + grace (the circle is alarmed)', () => {
    const mine: CheckIn = { member: A, timestamp: now - interval - DEFAULT_GRACE_SECONDS - 60, intervalSeconds: interval }
    expect(selfCheckInStatus(mine, now)).toBe('missed')
  })

  it('honours a custom remindBeforeSeconds', () => {
    const mine: CheckIn = { member: A, timestamp: now - interval + 90, intervalSeconds: interval } // due in 90s
    expect(selfCheckInStatus(mine, now, { remindBeforeSeconds: 60 })).toBe('ok')
    expect(selfCheckInStatus(mine, now, { remindBeforeSeconds: 120 })).toBe('due-soon')
  })

  it('rejects a non-positive remindBeforeSeconds', () => {
    const mine: CheckIn = { member: A, timestamp: now, intervalSeconds: interval }
    expect(() => selfCheckInStatus(mine, now, { remindBeforeSeconds: 0 })).toThrow()
  })
})

describe('buildAckSignal / decryptAck', () => {
  it('round-trips an ack through the group envelope', async () => {
    const event = await buildAckSignal({ groupId: 'g', seedHex: SEED, member: B, target: A, timestamp: 12_345 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(ACK_SIGNAL_TYPE)

    const back = await decryptAck(SEED, event.content)
    expect(back).toEqual<CheckInAck>({ member: B, target: A, timestamp: 12_345 })
  })

  it('a wrong seed cannot decrypt the ack', async () => {
    const event = await buildAckSignal({ groupId: 'g', seedHex: SEED, member: B, target: A })
    await expect(decryptAck('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('rejects malformed member or target', async () => {
    await expect(buildAckSignal({ groupId: 'g', seedHex: SEED, member: 'nope', target: A })).rejects.toThrow()
    await expect(buildAckSignal({ groupId: 'g', seedHex: SEED, member: B, target: 'nope' })).rejects.toThrow()
  })

  it('rejects acknowledging yourself', async () => {
    await expect(buildAckSignal({ groupId: 'g', seedHex: SEED, member: A, target: A })).rejects.toThrow()
  })
})

describe('classifyEscalation', () => {
  const now = 100_000
  const interval = 1800

  /** A check-in whose miss fired `agoSeconds` ago (missedAt = now - agoSeconds). */
  const missedFor = (member: string, agoSeconds: number): CheckIn => ({
    member,
    timestamp: now - agoSeconds - interval - DEFAULT_GRACE_SECONDS,
    intervalSeconds: interval,
  })

  it('returns [] when nobody is missed', () => {
    const states = classifyCheckins([{ member: A, timestamp: now - 60, intervalSeconds: interval }], now)
    expect(classifyEscalation(states, [], now)).toEqual([])
  })

  it('a fresh miss is unacknowledged at level 0', () => {
    const states = classifyCheckins([missedFor(A, 30)], now)
    const esc = classifyEscalation(states, [], now)
    expect(esc).toHaveLength(1)
    expect(esc[0]).toMatchObject({ member: A, status: 'unacknowledged', level: 0 })
    expect(esc[0].missedAt).toBe(now - 30)
  })

  it('level rises per step and clamps at 2', () => {
    const one = classifyEscalation(classifyCheckins([missedFor(A, DEFAULT_ESCALATION_STEP_SECONDS + 30)], now), [], now)
    expect(one[0].level).toBe(1)
    const deep = classifyEscalation(classifyCheckins([missedFor(A, DEFAULT_ESCALATION_STEP_SECONDS * 7)], now), [], now)
    expect(deep[0].level).toBe(2)
  })

  it('an ack after the last check-in acknowledges; earliest ack wins', () => {
    const states = classifyCheckins([missedFor(A, 600)], now)
    const acks: CheckInAck[] = [
      { member: C, target: A, timestamp: now - 100 },
      { member: B, target: A, timestamp: now - 300 },
    ]
    const esc = classifyEscalation(states, acks, now)
    expect(esc[0].status).toBe('acknowledged')
    expect(esc[0].acknowledgedBy).toBe(B)
    expect(esc[0].acknowledgedAt).toBe(now - 300)
  })

  it('ignores an ack from a previous episode (before the last check-in)', () => {
    const state = classifyCheckins([missedFor(A, 600)], now)
    const staleAck: CheckInAck = { member: B, target: A, timestamp: state[0].lastCheckIn - 10 }
    expect(classifyEscalation(state, [staleAck], now)[0].status).toBe('unacknowledged')
  })

  it('ignores acks for other members', () => {
    const states = classifyCheckins([missedFor(A, 600)], now)
    const esc = classifyEscalation(states, [{ member: B, target: C, timestamp: now - 100 }], now)
    expect(esc[0].status).toBe('unacknowledged')
  })

  it('sorts unacknowledged first, then longest-missed first', () => {
    const states = classifyCheckins([missedFor(A, 300), missedFor(B, 900), missedFor(C, 600)], now)
    const esc = classifyEscalation(states, [{ member: A, target: B, timestamp: now - 50 }], now)
    expect(esc.map((e) => e.member)).toEqual([C, A, B]) // C older than A; B acknowledged last
  })

  it('rejects a non-positive stepSeconds', () => {
    expect(() => classifyEscalation([], [], now, { stepSeconds: 0 })).toThrow()
  })
})
