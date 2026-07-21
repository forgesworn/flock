import { describe, it, expect } from 'vitest'
import { RADAR_SESSION } from '@forgesworn/flock/radarSession'
import {
  encodeSessionText,
  decodeSessionText,
  sessionCadenceOptions,
  sessionUntilSec,
  newSessionRequestId,
  type LiveRadarSession,
} from './radarSession'

const live = (over: Partial<LiveRadarSession> = {}): LiveRadarSession =>
  ({ sessionId: 'r1', ttlSec: 900, startAtSec: 1000, peer: 'pk-a', circleId: 'c1', ...over })

describe('session wire encode/decode', () => {
  it('round-trips all three kinds', () => {
    expect(decodeSessionText(encodeSessionText({ kind: 'req', requestId: 'r1', ttlSec: 900 })))
      .toEqual({ kind: 'req', requestId: 'r1', ttlSec: 900 })
    expect(decodeSessionText(encodeSessionText({ kind: 'acc', requestId: 'r1', ttlSec: 900, startAtSec: 1234 })))
      .toEqual({ kind: 'acc', requestId: 'r1', ttlSec: 900, startAtSec: 1234 })
    expect(decodeSessionText(encodeSessionText({ kind: 'stop', sessionId: 'r1' })))
      .toEqual({ kind: 'stop', sessionId: 'r1' })
  })

  it('every existing coordination label falls through as null', () => {
    for (const text of ['Come to me', 'On my way to you', "I'm here", 'free text', '']) {
      expect(decodeSessionText(text)).toBe(null)
    }
  })

  it('hostile input never throws and never parses', () => {
    for (const text of ['{', '{}', '{"rs":2,"k":"req","id":"x"}', '{"rs":1,"k":"nope","id":"x"}',
      '{"rs":1,"k":"req"}', '{"rs":1,"k":"req","id":""}', `{"rs":1,"k":"req","id":"${'x'.repeat(65)}"}`,
      '{"rs":1,"k":"acc","id":"x","ttl":900}', '{"rs":1,"k":"acc","id":"x","ttl":900,"start":-5}', 'null', '[1]']) {
      expect(decodeSessionText(text)).toBe(null)
    }
  })

  it('a hostile TTL is clamped at decode — never trusted downstream', () => {
    const req = decodeSessionText('{"rs":1,"k":"req","id":"x","ttl":999999}')
    expect(req).toEqual({ kind: 'req', requestId: 'x', ttlSec: RADAR_SESSION.maxTtlSec })
    const junk = decodeSessionText('{"rs":1,"k":"req","id":"x","ttl":"soon"}')
    expect(junk).toEqual({ kind: 'req', requestId: 'x', ttlSec: RADAR_SESSION.defaultTtlSec })
  })
})

describe('sessionCadenceOptions — the whole of a session\'s power', () => {
  it('a live session for the circle lifts to the 5 s / 30 s floors', () => {
    const m = new Map([['pk-a', live()]])
    expect(sessionCadenceOptions(m, 'c1', 1500)).toEqual({
      minIntervalSeconds: RADAR_SESSION.cadenceMovingSec,
      heartbeatSeconds: RADAR_SESSION.cadenceStationarySec,
    })
  })

  it('no session, other-circle session, or expired session → null (normal gate)', () => {
    expect(sessionCadenceOptions(new Map(), 'c1', 1500)).toBe(null)
    expect(sessionCadenceOptions(new Map([['pk-a', live({ circleId: 'c2' })]]), 'c1', 1500)).toBe(null)
    const over = 1000 + 900 + RADAR_SESSION.clockSkewSec + 1
    expect(sessionCadenceOptions(new Map([['pk-a', live()]]), 'c1', over)).toBe(null)
  })

  it('an over-cap TTL is cut at the cap here too', () => {
    const m = new Map([['pk-a', live({ ttlSec: 999_999 })]])
    expect(sessionCadenceOptions(m, 'c1', 1000 + RADAR_SESSION.maxTtlSec)).not.toBe(null)
    expect(sessionCadenceOptions(m, 'c1', 1000 + RADAR_SESSION.maxTtlSec + RADAR_SESSION.clockSkewSec + 1)).toBe(null)
  })
})

describe('sessionUntilSec — the native mirror expiry', () => {
  it('is the latest capped end across the circle\'s sessions, 0 when none', () => {
    expect(sessionUntilSec(new Map(), 'c1')).toBe(0)
    const m = new Map([
      ['pk-a', live()],
      ['pk-b', live({ peer: 'pk-b', startAtSec: 1200 })],
      ['pk-c', live({ peer: 'pk-c', circleId: 'c2', startAtSec: 9000 })],
    ])
    expect(sessionUntilSec(m, 'c1')).toBe(1200 + 900)
    expect(sessionUntilSec(new Map([['pk-a', live({ ttlSec: 999_999 })]]), 'c1')).toBe(1000 + RADAR_SESSION.maxTtlSec)
  })
})

describe('newSessionRequestId', () => {
  it('is 16 lowercase hex chars and unguessably fresh', () => {
    const a = newSessionRequestId()
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(newSessionRequestId()).not.toBe(a)
  })
})
