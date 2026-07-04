import { describe, it, expect } from 'vitest'
import { shouldAnswerFindPing, withinPingRateLimit, FIND_PING_CANCEL_SECONDS, FIND_PING_MIN_GAP_SECONDS } from './findping'

// Remote exact ping — the consent gate that decides whether THIS phone answers a
// "find my phone" request. A remotely-triggered disclosure is only legitimate
// when every gate holds; getting this wrong turns the feature into a stalking
// tool, so the safety cases are asserted explicitly.
describe('shouldAnswerFindPing', () => {
  const all = { preAuthorised: true, iAmFlaggedLost: true, targetedAtMe: true }

  it('answers only when pre-authorised AND flagged lost AND targeted at me', () => {
    expect(shouldAnswerFindPing(all)).toBe(true)
  })

  // SAFETY: without the owner's standing consent, a ping must do nothing — this
  // is what keeps disclosure originating from the device's own settings.
  it('never answers without pre-authorisation', () => {
    expect(shouldAnswerFindPing({ ...all, preAuthorised: false })).toBe(false)
  })

  // SAFETY: the visible "reported lost" alarm is the anti-stalk keystone — no fix
  // without it.
  it('never answers a phone that is not flagged lost', () => {
    expect(shouldAnswerFindPing({ ...all, iAmFlaggedLost: false })).toBe(false)
  })

  // SAFETY: a ping aimed at someone else must never make MY phone disclose.
  it('never answers a ping not targeted at me', () => {
    expect(shouldAnswerFindPing({ ...all, targetedAtMe: false })).toBe(false)
  })

  it('requires all three — any single missing gate refuses', () => {
    expect(shouldAnswerFindPing({ preAuthorised: false, iAmFlaggedLost: false, targetedAtMe: false })).toBe(false)
    expect(shouldAnswerFindPing({ preAuthorised: true, iAmFlaggedLost: true, targetedAtMe: false })).toBe(false)
    expect(shouldAnswerFindPing({ preAuthorised: true, iAmFlaggedLost: false, targetedAtMe: true })).toBe(false)
  })
})

describe('withinPingRateLimit', () => {
  it('allows the first answer (no previous)', () => {
    expect(withinPingRateLimit(undefined, 1000, FIND_PING_MIN_GAP_SECONDS)).toBe(true)
  })

  it('refuses a second answer inside the gap', () => {
    expect(withinPingRateLimit(1000, 1000 + FIND_PING_MIN_GAP_SECONDS - 1, FIND_PING_MIN_GAP_SECONDS)).toBe(false)
  })

  it('allows again once the gap has elapsed', () => {
    expect(withinPingRateLimit(1000, 1000 + FIND_PING_MIN_GAP_SECONDS, FIND_PING_MIN_GAP_SECONDS)).toBe(true)
  })
})

describe('constants', () => {
  it('a cancel window long enough to veto, short enough to be useful', () => {
    expect(FIND_PING_CANCEL_SECONDS).toBeGreaterThanOrEqual(5)
    expect(FIND_PING_CANCEL_SECONDS).toBeLessThanOrEqual(30)
  })
  it('a rate-limit gap of at least 30s (anti-spam / battery)', () => {
    expect(FIND_PING_MIN_GAP_SECONDS).toBeGreaterThanOrEqual(30)
  })
})
