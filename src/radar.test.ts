import { describe, it, expect } from 'vitest'
import {
  RADAR,
  initialBearingDeg,
  angularErrorDeg,
  classifyFreshness,
  radarGuidance,
  cueFor,
  targetMoved,
  courseFromFixes,
  type RadarInput,
  type TargetObservation,
} from './radar'

const origin = { lat: 0, lon: 0 }

/** A target observation with sensible defaults, overridable per test. */
function target(over: Partial<TargetObservation> = {}): TargetObservation {
  return { position: { lat: 0.01, lon: 0 }, uncertaintyMetres: 2.4, ageSeconds: 5, ...over }
}

function input(over: Partial<RadarInput> = {}): RadarInput {
  return { me: origin, headingDeg: 0, target: target(), ...over }
}

describe('initialBearingDeg', () => {
  it('points north for a target due north', () => {
    expect(initialBearingDeg(origin, { lat: 1, lon: 0 })).toBeCloseTo(0, 5)
  })

  it('points east for a target due east', () => {
    expect(initialBearingDeg(origin, { lat: 0, lon: 1 })).toBeCloseTo(90, 5)
  })

  it('points south for a target due south', () => {
    expect(initialBearingDeg(origin, { lat: -1, lon: 0 })).toBeCloseTo(180, 5)
  })

  it('points west for a target due west', () => {
    expect(initialBearingDeg(origin, { lat: 0, lon: -1 })).toBeCloseTo(270, 5)
  })

  it('points roughly north-east for a diagonal target', () => {
    expect(initialBearingDeg(origin, { lat: 1, lon: 1 })).toBeCloseTo(45, 0)
  })

  it('rejects an out-of-range coordinate', () => {
    expect(() => initialBearingDeg({ lat: 91, lon: 0 }, origin)).toThrow()
    expect(() => initialBearingDeg(origin, { lat: 0, lon: 181 })).toThrow()
  })
})

describe('angularErrorDeg', () => {
  it('is zero when the phone points straight at the target', () => {
    expect(angularErrorDeg(90, 90)).toBe(0)
  })

  it('is positive when the target is to the right (turn clockwise)', () => {
    expect(angularErrorDeg(30, 0)).toBe(30)
  })

  it('is negative when the target is to the left', () => {
    expect(angularErrorDeg(330, 0)).toBe(-30)
  })

  it('wraps across north: bearing 10 with heading 350 is a small right turn', () => {
    expect(angularErrorDeg(10, 350)).toBe(20)
  })

  it('wraps across north the other way: bearing 350 with heading 10', () => {
    expect(angularErrorDeg(350, 10)).toBe(-20)
  })

  it('a target dead behind reads 180, never -180 or 540', () => {
    expect(angularErrorDeg(180, 0)).toBe(180)
    expect(angularErrorDeg(0, 180)).toBe(180)
  })
})

describe('classifyFreshness', () => {
  it('fresh up to the fresh window', () => {
    expect(classifyFreshness(0)).toBe('fresh')
    expect(classifyFreshness(RADAR.freshSeconds)).toBe('fresh')
  })

  it('aging between fresh and stale', () => {
    expect(classifyFreshness(RADAR.freshSeconds + 1)).toBe('aging')
    expect(classifyFreshness(RADAR.staleSeconds)).toBe('aging')
  })

  it('stale beyond the stale window (matches the app presence window)', () => {
    expect(classifyFreshness(RADAR.staleSeconds + 1)).toBe('stale')
    // The presence UI calls a member stale after 600 s — the radar must agree,
    // or the map and the tracker would tell two different stories.
    expect(RADAR.staleSeconds).toBe(600)
  })
})

describe('radarGuidance — degraded states', () => {
  // SAFETY: no target (not sharing, no beacon yet, private/no-report withheld)
  // must read as unavailable — never a stale pointer to an old spot.
  it('no target → unavailable, with no fabricated distance or bearing', () => {
    const g = radarGuidance(input({ target: null }))
    expect(g.state).toBe('unavailable')
    expect(g.distanceMetres).toBeNull()
    expect(g.bearingDeg).toBeNull()
    expect(g.alignment).toBeNull()
    expect(g.bearingUsable).toBe(false)
  })

  it('no own fix → no-fix, target freshness still reported', () => {
    const g = radarGuidance(input({ me: null }))
    expect(g.state).toBe('no-fix')
    expect(g.distanceMetres).toBeNull()
    expect(g.freshness).toBe('fresh')
    expect(g.bearingUsable).toBe(false)
  })

  // SAFETY: a strong cue to a 5-minute-old target is worse than a degraded cue
  // that admits it — stale wins over everything else.
  it('a stale target → stale, and the bearing is not usable', () => {
    const g = radarGuidance(input({ target: target({ ageSeconds: RADAR.staleSeconds + 60 }) }))
    expect(g.state).toBe('stale')
    expect(g.bearingUsable).toBe(false)
    expect(g.alignment).toBeNull()
    // Distance is still shown (an honest "last seen ~1 km away"), just not guided.
    expect(g.distanceMetres).toBeGreaterThan(0)
  })

  // SAFETY: a coarse share must never be presented as a precise pointer — the
  // cell centre is the grid's position, not the person's (FLOCK §6).
  it('a coarse target (uncertainty above the coarse threshold) → coarse, bearing never usable', () => {
    const g = radarGuidance(input({ target: target({ uncertaintyMetres: 610 }) }))
    expect(g.state).toBe('coarse')
    expect(g.bearingUsable).toBe(false)
    expect(g.alignment).toBeNull()
    expect(g.uncertaintyMetres).toBe(610)
  })

  it('a coarse target is never "point", however close or far', () => {
    for (const lat of [0.0005, 0.01, 0.5]) {
      const g = radarGuidance(input({ target: target({ position: { lat, lon: 0 }, uncertaintyMetres: 610 }) }))
      expect(g.state === 'point' || g.state === 'arrived').toBe(false)
      expect(g.bearingUsable).toBe(false)
    }
  })

  it('no compass heading → no-heading, with distance and bearing but no alignment claim', () => {
    const g = radarGuidance(input({ headingDeg: null }))
    expect(g.state).toBe('no-heading')
    expect(g.distanceMetres).toBeGreaterThan(0)
    expect(g.bearingDeg).not.toBeNull()
    expect(g.relativeBearingDeg).toBeNull()
    expect(g.alignment).toBeNull()
  })
})

describe('radarGuidance — live guidance', () => {
  it('a fresh precise target ahead → point, aligned', () => {
    // ~1.1 km due north, heading north.
    const g = radarGuidance(input())
    expect(g.state).toBe('point')
    expect(g.freshness).toBe('fresh')
    expect(g.bearingUsable).toBe(true)
    expect(g.alignment).toBe('aligned')
    expect(g.relativeBearingDeg).toBeCloseTo(0, 5)
  })

  it('a target off to the side → near / off tiers by angular error', () => {
    const near = radarGuidance(input({ headingDeg: 45 })) // error -45°
    expect(near.alignment).toBe('near')
    const off = radarGuidance(input({ headingDeg: 120 })) // error -120°
    expect(off.alignment).toBe('off')
  })

  it('arrived when within the arrival radius of a fresh precise target', () => {
    // ~11 m north.
    const g = radarGuidance(input({ target: target({ position: { lat: 0.0001, lon: 0 } }) }))
    expect(g.state).toBe('arrived')
  })

  it('arrival radius grows with the target uncertainty (never claims sub-uncertainty precision)', () => {
    // 19 m-uncertain target (building level, still precise-ish) at ~17 m.
    const g = radarGuidance(input({ target: target({ position: { lat: 0.00015, lon: 0 }, uncertaintyMetres: 19 }) }))
    expect(g.state).toBe('arrived')
  })

  it('an aging (heartbeat-old) target still guides, flagged aging', () => {
    const g = radarGuidance(input({ target: target({ ageSeconds: 300 }) }))
    expect(g.state).toBe('point')
    expect(g.freshness).toBe('aging')
  })
})

describe('cueFor — the beep grammar', () => {
  const aligned = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.0005, lon: 0 } }) }))) // ~55 m, aligned
  const alignedFar = cueFor(radarGuidance(input()))                                                       // ~1.1 km, aligned
  const near = cueFor(radarGuidance(input({ headingDeg: 45 })))
  const off = cueFor(radarGuidance(input({ headingDeg: 150 })))
  const stale = cueFor(radarGuidance(input({ target: target({ ageSeconds: 700 }) })))
  const coarse = cueFor(radarGuidance(input({ target: target({ uncertaintyMetres: 610 }) })))
  const unavailable = cueFor(radarGuidance(input({ target: null })))
  const arrived = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.00005, lon: 0 } }) })))

  it('close and aligned → the triple burst', () => {
    expect(aligned.pattern).toBe('triple')
  })

  it('aligned but distant → the confident pair', () => {
    expect(alignedFar.pattern).toBe('double')
  })

  it('correcting → single beeps that slow as the error grows', () => {
    expect(near.pattern).toBe('single')
    expect(off.pattern).toBe('single')
    expect(off.periodMs).toBeGreaterThan(near.periodMs)
  })

  it('the grammar accelerates as you align and approach', () => {
    expect(aligned.periodMs).toBeLessThan(alignedFar.periodMs)
    expect(alignedFar.periodMs).toBeLessThan(near.periodMs)
    expect(near.periodMs).toBeLessThan(off.periodMs)
  })

  it('tone brightens with alignment', () => {
    expect(aligned.toneHz).toBeGreaterThan(near.toneHz)
    expect(near.toneHz).toBeGreaterThan(off.toneHz)
  })

  // SAFETY: stale/coarse/unavailable degrade to a sparse dull pulse — they must
  // never sound like confident guidance (the cue would lie by omission).
  it('stale, coarse and unavailable are all sparse, duller and slower than any live cue', () => {
    for (const c of [stale, coarse, unavailable]) {
      expect(c.pattern).toBe('sparse')
      expect(c.toneHz).toBeLessThan(off.toneHz)
      expect(c.periodMs).toBeGreaterThanOrEqual(off.periodMs)
    }
  })

  it('arrived → immediate silence with a single confirmation haptic', () => {
    expect(arrived.pattern).toBe('silent')
    expect(arrived.vibrateMs.length).toBeGreaterThan(0)
  })

  it('every audible cue has a haptic mirror (works muted, in a loud place)', () => {
    for (const c of [aligned, alignedFar, near, off, stale, coarse, unavailable]) {
      expect(c.vibrateMs.length).toBeGreaterThan(0)
    }
  })

  it('no-heading falls back to a distance-paced pulse (walk-a-few-steps mode)', () => {
    const closeCue = cueFor(radarGuidance(input({ headingDeg: null, target: target({ position: { lat: 0.0005, lon: 0 } }) })))
    const farCue = cueFor(radarGuidance(input({ headingDeg: null })))
    expect(closeCue.pattern).toBe('single')
    expect(closeCue.periodMs).toBeLessThan(farCue.periodMs)
  })

  it('a coarse cue quickens slightly as you close on the disclosed area, but stays sparse', () => {
    const farAway = cueFor(radarGuidance(input({ target: target({ uncertaintyMetres: 610, position: { lat: 0.05, lon: 0 } }) })))
    const inside = cueFor(radarGuidance(input({ target: target({ uncertaintyMetres: 610, position: { lat: 0.001, lon: 0 } }) })))
    expect(farAway.pattern).toBe('sparse')
    expect(inside.pattern).toBe('sparse')
    expect(inside.periodMs).toBeLessThan(farAway.periodMs)
  })
})

describe('targetMoved', () => {
  const at = (lat: number, lon: number, u = 2.4): { position: { lat: number; lon: number }; uncertaintyMetres: number } =>
    ({ position: { lat, lon }, uncertaintyMetres: u })

  it('a first observation is never "moved"', () => {
    expect(targetMoved(null, at(0, 0))).toBe(false)
  })

  it('GPS jitter below the floor is not movement', () => {
    // ~11 m — under the 25 m floor.
    expect(targetMoved(at(0, 0), at(0.0001, 0))).toBe(false)
  })

  it('a real walk between precise fixes is movement', () => {
    // ~55 m.
    expect(targetMoved(at(0, 0), at(0.0005, 0))).toBe(true)
  })

  // SAFETY: a coarse target "moves" only on a change bigger than its own
  // uncertainty — anything less would be reading tea leaves from cell centres.
  it('coarse observations only move when the change exceeds the uncertainty', () => {
    expect(targetMoved(at(0, 0, 610), at(0.003, 0, 610))).toBe(false) // ~330 m < 610 m
    expect(targetMoved(at(0, 0, 610), at(0.011, 0, 610))).toBe(true) // ~1.2 km — a cell change
  })
})

describe('courseFromFixes', () => {
  const fix = (lat: number, lon: number, atSec: number): { position: { lat: number; lon: number }; atSec: number } =>
    ({ position: { lat, lon }, atSec })

  it('a few steps north give a northward course', () => {
    expect(courseFromFixes(fix(0, 0, 0), fix(0.0002, 0, 10))).toBeCloseTo(0, 0)
  })

  it('standing still gives no course (too little movement to trust)', () => {
    expect(courseFromFixes(fix(0, 0, 0), fix(0.00002, 0, 10))).toBeNull()
  })

  it('a zero or negative time step gives no course', () => {
    expect(courseFromFixes(fix(0, 0, 10), fix(0.001, 0, 10))).toBeNull()
    expect(courseFromFixes(fix(0, 0, 10), fix(0.001, 0, 5))).toBeNull()
  })
})
