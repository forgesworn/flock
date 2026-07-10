import { describe, it, expect } from 'vitest'
import { shouldRing, RING_VIBRATION, RING_REASON } from './ring'

// "Make it ring" — a lost phone escalates an incoming *targeted* buzz to a loud
// alarm. The decision composes two existing signals (buzz + lost) with no
// protocol change, so the whole feature turns on this one pure gate.
describe('shouldRing', () => {
  it('rings when a buzz is targeted at me AND my phone is flagged lost', () => {
    expect(shouldRing({ targetedAtMe: true, iAmFlaggedLost: true })).toBe(true)
  })

  // SAFETY: a normal targeted buzz (friend → friend "come home") must NOT blast an
  // alarm — only a phone the circle has flagged lost rings.
  it('does not ring a phone that is not flagged lost', () => {
    expect(shouldRing({ targetedAtMe: true, iAmFlaggedLost: false })).toBe(false)
  })

  // A whole-circle buzz (no target) is frequent (quick actions) — it must not
  // ring a lost phone; only a buzz deliberately aimed at it does.
  it('does not ring on an untargeted (whole-circle) buzz, even when flagged lost', () => {
    expect(shouldRing({ targetedAtMe: false, iAmFlaggedLost: true })).toBe(false)
  })

  it('does not ring when neither condition holds', () => {
    expect(shouldRing({ targetedAtMe: false, iAmFlaggedLost: false })).toBe(false)
  })
})

describe('ring constants', () => {
  it('RING_VIBRATION is a long, insistent pattern (distinct from a normal buzz)', () => {
    expect(Array.isArray(RING_VIBRATION)).toBe(true)
    // Meaningfully longer total than a normal buzz's ~[200,100,200].
    const total = RING_VIBRATION.reduce((a: number, b: number) => a + b, 0)
    expect(total).toBeGreaterThan(1500)
  })

  it('RING_REASON is a non-empty, recognisable label', () => {
    expect(RING_REASON.trim().length).toBeGreaterThan(0)
  })
})
