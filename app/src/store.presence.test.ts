import { describe, it, expect } from 'vitest'
import { prunePresence, PRESENCE_MAX_AGE_SEC } from './store'
import type { MemberBeacon } from '@forgesworn/flock'

const NOW = 1_000_000
const beacon = (member: string, ageSec: number): MemberBeacon =>
  ({ member, geohash: 'gcpvhc', precision: 6, timestamp: NOW - ageSec })

// Presence is a convenience cache (map pins survive a refresh). Pruning keeps it
// honest: never resurrect an ancient pin, never leak a circle you've left.
describe('prunePresence', () => {
  it('keeps a recent beacon for a circle that still exists', () => {
    const out = prunePresence({ c1: [beacon('a', 60)] }, ['c1'], NOW, PRESENCE_MAX_AGE_SEC)
    expect(out).toEqual({ c1: [beacon('a', 60)] })
  })

  it('drops a beacon older than the max age (stale-and-gone → noise)', () => {
    const out = prunePresence({ c1: [beacon('a', PRESENCE_MAX_AGE_SEC + 1)] }, ['c1'], NOW, PRESENCE_MAX_AGE_SEC)
    expect(out).toEqual({})
  })

  it('keeps a beacon exactly at the max age (boundary is inclusive)', () => {
    const out = prunePresence({ c1: [beacon('a', PRESENCE_MAX_AGE_SEC)] }, ['c1'], NOW, PRESENCE_MAX_AGE_SEC)
    expect(out.c1).toHaveLength(1)
  })

  it('drops presence for a circle that no longer exists (left / disbanded / reseeded)', () => {
    const out = prunePresence({ gone: [beacon('a', 60)] }, ['c1'], NOW, PRESENCE_MAX_AGE_SEC)
    expect(out).toEqual({})
  })

  it('prunes per-member: keeps the fresh, drops the ancient, in one circle', () => {
    const out = prunePresence(
      { c1: [beacon('fresh', 60), beacon('old', PRESENCE_MAX_AGE_SEC + 100)] },
      ['c1'], NOW, PRESENCE_MAX_AGE_SEC,
    )
    expect(out.c1).toEqual([beacon('fresh', 60)])
  })

  it('is pure — does not mutate its input', () => {
    const input = { c1: [beacon('a', 60)] }
    const snapshot = JSON.parse(JSON.stringify(input))
    prunePresence(input, ['c1'], NOW, PRESENCE_MAX_AGE_SEC)
    expect(input).toEqual(snapshot)
  })
})
