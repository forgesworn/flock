import { describe, it, expect } from 'vitest'
import {
  classifyCheckins,
  missedCheckins,
  buildCheckInSignal,
  decryptCheckIn,
  CHECKIN_SIGNAL_TYPE,
  DEFAULT_GRACE_SECONDS,
  type CheckIn,
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
