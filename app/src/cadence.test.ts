import { describe, it, expect } from 'vitest'
import { shouldEmitBeacon, type BeaconCadence } from './cadence'

const OPTS = { minIntervalSeconds: 45, heartbeatSeconds: 300 }
const fresh: BeaconCadence = { lastGeohash: null, lastSentAt: 0 }

describe('shouldEmitBeacon', () => {
  it('sends the first beacon immediately, ignoring the rate floor', () => {
    expect(shouldEmitBeacon('gcpvhc', fresh, 0, OPTS)).toBe(true)
  })

  it('suppresses an identical cell re-sent within the rate floor (standing still)', () => {
    const prev = { lastGeohash: 'gcpvhc', lastSentAt: 1000 }
    expect(shouldEmitBeacon('gcpvhc', prev, 1000 + 20, OPTS)).toBe(false)
  })

  it('suppresses even a *moved* cell inside the rate floor (no bursts crossing cells)', () => {
    const prev = { lastGeohash: 'gcpvhc', lastSentAt: 1000 }
    expect(shouldEmitBeacon('gcpvhd', prev, 1000 + 20, OPTS)).toBe(false)
  })

  it('sends once the member moves to a new cell and the floor has passed', () => {
    const prev = { lastGeohash: 'gcpvhc', lastSentAt: 1000 }
    expect(shouldEmitBeacon('gcpvhd', prev, 1000 + 46, OPTS)).toBe(true)
  })

  it('stays silent in the same cell between floor and heartbeat (stationary → no chatter)', () => {
    const prev = { lastGeohash: 'gcpvhc', lastSentAt: 1000 }
    expect(shouldEmitBeacon('gcpvhc', prev, 1000 + 120, OPTS)).toBe(false)
  })

  it('lets a heartbeat through in the same cell once the interval elapses (keeps presence active)', () => {
    const prev = { lastGeohash: 'gcpvhc', lastSentAt: 1000 }
    expect(shouldEmitBeacon('gcpvhc', prev, 1000 + 300, OPTS)).toBe(true)
  })

  it('never sends when the clock goes backwards (skew is treated as "too soon")', () => {
    const prev = { lastGeohash: 'gcpvhc', lastSentAt: 1000 }
    expect(shouldEmitBeacon('gcpvhd', prev, 990, OPTS)).toBe(false)
  })
})
