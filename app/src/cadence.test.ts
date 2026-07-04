import { describe, it, expect } from 'vitest'
import { shouldEmitBeacon, hasMoved, nextPollDelaySeconds, jitteredSeconds, shouldEmitCover, type BeaconCadence } from './cadence'

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

  // Battery-aware widening: a low, discharging battery doubles every delay —
  // but the ceiling still holds, so a still member NEVER ages past the presence
  // stale window into a false "gone home" (safety cap beats battery).
  it('conserve doubles the delay at every streak', () => {
    expect(nextPollDelaySeconds(0, BOUNDS, { conserve: true })).toBe(60)
    expect(nextPollDelaySeconds(1, BOUNDS, { conserve: true })).toBe(120)
  })

  it('conserve still respects the stale-window ceiling', () => {
    expect(nextPollDelaySeconds(2, BOUNDS, { conserve: true })).toBe(180) // 240 capped
    expect(nextPollDelaySeconds(50, BOUNDS, { conserve: true })).toBe(180)
  })
})

// Timing hygiene (audit F1 / PRIVACY.md "cover traffic so silence vs activity
// isn't itself a signal"): a fixed 45 s/300 s cadence is a fingerprint a logging
// relay can read straight off arrival timing. Jitter blurs the exact period;
// cover traffic narrows the ~6x moving-vs-still swing.
describe('jitteredSeconds', () => {
  it('returns the base unchanged at the mid-point random value (no jitter applied)', () => {
    expect(jitteredSeconds(300, 0.2, 0.5)).toBe(300)
  })

  it('spreads symmetrically around the base within ±jitterFraction', () => {
    expect(jitteredSeconds(300, 0.2, 0)).toBe(240) // 300 * (1 - 0.2)
    expect(jitteredSeconds(300, 0.2, 1)).toBe(360) // 300 * (1 + 0.2)
  })

  it('zero jitter fraction always returns the exact base', () => {
    expect(jitteredSeconds(45, 0, 0)).toBe(45)
    expect(jitteredSeconds(45, 0, 1)).toBe(45)
  })

  it('clamps an out-of-range rand into [0,1] rather than inverting the spread', () => {
    expect(jitteredSeconds(300, 0.2, -5)).toBe(240)
    expect(jitteredSeconds(300, 0.2, 5)).toBe(360)
  })

  it('never returns below 1 second even with an extreme fraction', () => {
    expect(jitteredSeconds(1, 5, 0)).toBe(1)
  })
})

describe('shouldEmitCover (low-rate stationary cover traffic)', () => {
  const OPTS = { intervalSeconds: 120, jitterFraction: 0.2 }

  it('fires immediately when nothing has been sent yet (lastCoverAt = 0)', () => {
    expect(shouldEmitCover(0, 1000, OPTS, 0.5)).toBe(true)
  })

  it('stays silent before the (jittered) interval has elapsed', () => {
    expect(shouldEmitCover(1000, 1000 + 100, OPTS, 0.5)).toBe(false)
  })

  it('fires once the jittered interval has elapsed', () => {
    expect(shouldEmitCover(1000, 1000 + 120, OPTS, 0.5)).toBe(true)
  })

  it('a low rand widens the wait (jitter applies to the cover cadence too)', () => {
    // rand=1 → interval jitters up to 144s, so 130s in must still be silent
    expect(shouldEmitCover(1000, 1000 + 130, OPTS, 1)).toBe(false)
    expect(shouldEmitCover(1000, 1000 + 144, OPTS, 1)).toBe(true)
  })
})
