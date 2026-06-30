import { describe, it, expect } from 'vitest'
import {
  nightOutExpiry,
  buildNightOutGroupEvent,
  classifyPresence,
  stillOut,
  geoOutliers,
  DEFAULT_STALE_AFTER_SECONDS,
  type MemberBeacon,
} from './nightout.js'
import type { LatLng } from './geofence.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const GROUP_KIND = 30_078

function tagValue(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1]
}

describe('nightOutExpiry', () => {
  it('adds the duration to the start time', () => {
    expect(nightOutExpiry(1000, 3600)).toBe(4600)
  })

  it('rejects invalid inputs', () => {
    expect(() => nightOutExpiry(-1, 3600)).toThrow()
    expect(() => nightOutExpiry(1000, 0)).toThrow()
    expect(() => nightOutExpiry(1000, 1.5)).toThrow()
  })
})

describe('buildNightOutGroupEvent', () => {
  it('builds a kind-30078 group event with a NIP-40 expiration', () => {
    const event = buildNightOutGroupEvent({
      groupId: 'pub-crawl',
      members: [A, B],
      encryptedContent: 'encrypted-config',
      startedAt: 1000,
      durationSeconds: 6 * 60 * 60,
    })
    expect(event.kind).toBe(GROUP_KIND)
    expect(tagValue(event, 'expiration')).toBe(String(1000 + 6 * 60 * 60))
    expect(tagValue(event, 'd')).toBe('ssg/pub-crawl')
    expect(event.tags.filter((t) => t[0] === 'p').length).toBe(2)
  })

  it('rejects a malformed member pubkey (via canary-kit validation)', () => {
    expect(() => buildNightOutGroupEvent({
      groupId: 'pub-crawl', members: ['nope'], encryptedContent: 'x',
      startedAt: 1000, durationSeconds: 3600,
    })).toThrow()
  })
})

describe('classifyPresence', () => {
  const now = 10_000
  const beacons: MemberBeacon[] = [
    { member: A, geohash: 'gcpuuz', precision: 6, timestamp: now - 60 },      // active
    { member: A, geohash: 'gcpuv0', precision: 6, timestamp: now - 30 },      // newer A
    { member: B, geohash: 'gcpuuy', precision: 6, timestamp: now - 1200 },    // stale
  ]

  it('collapses to the latest beacon per member', () => {
    const entries = classifyPresence(beacons, now)
    const a = entries.find((e) => e.member === A)
    expect(a?.lastSeen).toBe(now - 30)
    expect(a?.geohash).toBe('gcpuv0')
  })

  it('marks members active or stale by the threshold', () => {
    const entries = classifyPresence(beacons, now)
    expect(entries.find((e) => e.member === A)?.status).toBe('active')
    expect(entries.find((e) => e.member === B)?.status).toBe('stale')
  })

  it('sorts most-recent-first', () => {
    const entries = classifyPresence(beacons, now)
    expect(entries[0].member).toBe(A)
    expect(entries[entries.length - 1].member).toBe(B)
  })

  it('honours a custom staleness window', () => {
    const entries = classifyPresence(beacons, now, { staleAfterSeconds: 20 })
    expect(entries.every((e) => e.status === 'stale')).toBe(true)
  })

  it('uses a sensible default staleness window', () => {
    expect(DEFAULT_STALE_AFTER_SECONDS).toBeGreaterThan(0)
  })

  it('rejects an invalid staleness window', () => {
    expect(() => classifyPresence(beacons, now, { staleAfterSeconds: 0 })).toThrow()
  })
})

describe('stillOut', () => {
  it('returns only the active members', () => {
    const now = 10_000
    const entries = classifyPresence([
      { member: A, geohash: 'g', precision: 6, timestamp: now - 30 },
      { member: B, geohash: 'g', precision: 6, timestamp: now - 5000 },
    ], now)
    const active = stillOut(entries)
    expect(active.map((e) => e.member)).toEqual([A])
  })
})

describe('geoOutliers', () => {
  const clustered: LatLng = { lat: 51.5074, lon: -0.1278 } // central London
  const near: LatLng = { lat: 51.5079, lon: -0.1270 }      // ~80 m away
  const far: LatLng = { lat: 51.4700, lon: -0.0900 }       // a few km away

  it('flags a member far from the group centroid', () => {
    const outliers = geoOutliers([
      { member: A, position: clustered },
      { member: B, position: near },
      { member: C, position: far },
    ], 1000)
    expect(outliers).toEqual([C])
  })

  it('flags nobody when the group is together', () => {
    const outliers = geoOutliers([
      { member: A, position: clustered },
      { member: B, position: near },
    ], 1000)
    expect(outliers).toEqual([])
  })

  it('returns empty for no points', () => {
    expect(geoOutliers([], 1000)).toEqual([])
  })

  it('rejects a non-positive threshold', () => {
    expect(() => geoOutliers([{ member: A, position: clustered }], 0)).toThrow()
  })
})
