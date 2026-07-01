import { describe, it, expect } from 'vitest'
import { shouldEmitBeacon, hasMoved, nextPollDelaySeconds, type BeaconCadence } from './cadence'

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

// Movement detection for the adaptive sampling poll — jitter must not read as
// movement, especially for a noisy low-power (network) fix.
describe('hasMoved', () => {
  it('is movement when the step clearly exceeds the floor and both accuracies', () => {
    expect(hasMoved(200, 10, 10, 30)).toBe(true)
  })

  it('is NOT movement when the step is within the accuracy jitter of a noisy fix', () => {
    expect(hasMoved(100, 10, 150, 30)).toBe(false) // a ±150 m network fix can wander 100 m sat still
  })

  it('is NOT movement when below the jitter floor even with sharp fixes', () => {
    expect(hasMoved(20, 5, 5, 30)).toBe(false)
  })

  it('uses the coarser of the two accuracies as the threshold', () => {
    expect(hasMoved(120, 150, 5, 30)).toBe(false)
    expect(hasMoved(180, 150, 5, 30)).toBe(true)
  })
})

// Stationary back-off: sample often when moving, exponentially less when still,
// capped so presence never goes fully quiet within the stale window.
describe('nextPollDelaySeconds', () => {
  const BOUNDS = { minSeconds: 30, maxSeconds: 180 }

  it('samples at the floor while moving (streak 0)', () => {
    expect(nextPollDelaySeconds(0, BOUNDS)).toBe(30)
  })

  it('backs off exponentially as the stationary streak grows', () => {
    expect(nextPollDelaySeconds(1, BOUNDS)).toBe(60)
    expect(nextPollDelaySeconds(2, BOUNDS)).toBe(120)
  })

  it('never exceeds the ceiling', () => {
    expect(nextPollDelaySeconds(3, BOUNDS)).toBe(180) // 240 capped
    expect(nextPollDelaySeconds(50, BOUNDS)).toBe(180)
  })

  it('treats a negative/garbage streak as "just moved" (floor)', () => {
    expect(nextPollDelaySeconds(-3, BOUNDS)).toBe(30)
  })
})
