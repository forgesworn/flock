import { describe, it, expect } from 'vitest'
import {
  pushCrumb,
  buildTrailSignal,
  decryptTrail,
  TRAIL_SIGNAL_TYPE,
  DEFAULT_TRAIL_MAX_CRUMBS,
  DEFAULT_TRAIL_MAX_AGE_SECONDS,
  DEFAULT_TRAIL_MIN_SPACING_SECONDS,
  type Breadcrumb,
  type Trail,
} from './trail.js'
import { decryptCheckIn } from './checkin.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)

const crumb = (timestamp: number, geohash = 'gcpuuz012'): Breadcrumb => ({ geohash, precision: 9, timestamp })

describe('pushCrumb', () => {
  it('appends the first crumb', () => {
    expect(pushCrumb([], crumb(1000))).toEqual([crumb(1000)])
  })

  it('skips a crumb inside the minimum spacing window', () => {
    const trail = [crumb(1000)]
    expect(pushCrumb(trail, crumb(1000 + DEFAULT_TRAIL_MIN_SPACING_SECONDS - 1))).toBe(trail)
    expect(pushCrumb(trail, crumb(1000 + DEFAULT_TRAIL_MIN_SPACING_SECONDS))).toHaveLength(2)
  })

  it('skips an out-of-order (older) crumb', () => {
    const trail = [crumb(1000)]
    expect(pushCrumb(trail, crumb(900))).toBe(trail)
  })

  it('drops crumbs older than the max age (relative to the newest)', () => {
    const trail = [crumb(1000), crumb(1200)]
    const out = pushCrumb(trail, crumb(1000 + DEFAULT_TRAIL_MAX_AGE_SECONDS + 1))
    expect(out.map((c) => c.timestamp)).toEqual([1200, 1000 + DEFAULT_TRAIL_MAX_AGE_SECONDS + 1])
  })

  it('caps the buffer at maxCrumbs, keeping the newest', () => {
    let trail: Breadcrumb[] = []
    for (let i = 0; i <= DEFAULT_TRAIL_MAX_CRUMBS; i++) {
      trail = pushCrumb(trail, crumb(1000 + i * 60), { maxAgeSeconds: 100_000 })
    }
    expect(trail).toHaveLength(DEFAULT_TRAIL_MAX_CRUMBS)
    expect(trail[0].timestamp).toBe(1060) // oldest was evicted
  })

  it('never mutates the input buffer', () => {
    const trail = [crumb(1000)]
    pushCrumb(trail, crumb(2000))
    expect(trail).toEqual([crumb(1000)])
  })

  it('honours custom spacing', () => {
    const trail = [crumb(1000)]
    expect(pushCrumb(trail, crumb(1010), { minSpacingSeconds: 5 })).toHaveLength(2)
  })

  it('rejects a malformed crumb', () => {
    expect(() => pushCrumb([], { geohash: '', precision: 9, timestamp: 1000 })).toThrow()
    expect(() => pushCrumb([], { geohash: 'gcpuuz', precision: 0, timestamp: 1000 })).toThrow()
    expect(() => pushCrumb([], { geohash: 'gcpuuz', precision: 9, timestamp: Number.NaN })).toThrow()
  })
})

describe('buildTrailSignal / decryptTrail', () => {
  const crumbs = [crumb(1000), crumb(1120, 'gcpuuz013')]

  it('round-trips a trail through the duress key', async () => {
    const event = await buildTrailSignal({ groupId: 'g', seedHex: SEED, member: A, reason: 'help', crumbs, timestamp: 2000 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(TRAIL_SIGNAL_TYPE)

    const back = await decryptTrail(SEED, event.content)
    expect(back).toEqual<Trail>({ member: A, reason: 'help', crumbs, timestamp: 2000 })
  })

  it('a wrong seed cannot decrypt the trail', async () => {
    const event = await buildTrailSignal({ groupId: 'g', seedHex: SEED, member: A, reason: 'breach', crumbs })
    await expect(decryptTrail('f'.repeat(64), event.content)).rejects.toThrow()
  })

  it('the group envelope key cannot decrypt a trail (duress-key domain separation)', async () => {
    const event = await buildTrailSignal({ groupId: 'g', seedHex: SEED, member: A, reason: 'help', crumbs })
    await expect(decryptCheckIn(SEED, event.content)).rejects.toThrow()
  })

  it('rejects invalid params', async () => {
    await expect(buildTrailSignal({ groupId: 'g', seedHex: SEED, member: 'nope', reason: 'help', crumbs })).rejects.toThrow()
    await expect(buildTrailSignal({ groupId: 'g', seedHex: SEED, member: A, reason: 'oops' as 'help', crumbs })).rejects.toThrow()
    await expect(buildTrailSignal({ groupId: 'g', seedHex: SEED, member: A, reason: 'help', crumbs: [] })).rejects.toThrow()
    const tooMany = Array.from({ length: DEFAULT_TRAIL_MAX_CRUMBS + 1 }, (_, i) => crumb(1000 + i * 60))
    await expect(buildTrailSignal({ groupId: 'g', seedHex: SEED, member: A, reason: 'help', crumbs: tooMany })).rejects.toThrow()
  })
})
