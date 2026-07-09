import { describe, it, expect } from 'vitest'
import { headingFromOrientation, blipXY, niceRange, freshnessLabel, statusCopy, BLIP_MAX_RADIUS } from './radarView'
import { radarGuidance } from '@forgesworn/flock'

describe('headingFromOrientation', () => {
  it('uses webkitCompassHeading directly (iOS)', () => {
    expect(headingFromOrientation({ alpha: null, webkitCompassHeading: 45 })).toBe(45)
  })

  it('converts an absolute alpha to a compass heading', () => {
    // alpha 0 = facing north; alpha 90 (device rotated 90° anticlockwise) = heading 270.
    expect(headingFromOrientation({ alpha: 0, absolute: true })).toBe(0)
    expect(headingFromOrientation({ alpha: 90, absolute: true })).toBe(270)
  })

  // SAFETY: a relative alpha has an arbitrary zero — treating it as a compass
  // would point somewhere confident and wrong. Null = the honest "no compass".
  it('refuses a non-absolute alpha', () => {
    expect(headingFromOrientation({ alpha: 120 })).toBeNull()
    expect(headingFromOrientation({ alpha: 120, absolute: false })).toBeNull()
  })

  it('compensates for a rotated screen', () => {
    expect(headingFromOrientation({ alpha: 0, absolute: true }, 90)).toBe(90)
    expect(headingFromOrientation({ alpha: null, webkitCompassHeading: 350 }, 90)).toBe(80)
  })

  it('handles a missing alpha', () => {
    expect(headingFromOrientation({ alpha: null, absolute: true })).toBeNull()
  })
})

describe('blipXY', () => {
  it('dead ahead sits straight up the scope', () => {
    const { x, y } = blipXY(0, 250, 500)
    expect(x).toBeCloseTo(0, 5)
    expect(y).toBeCloseTo(-0.46, 2) // half range × max radius, upward (screen y down)
  })

  it('due right sits on the +x axis', () => {
    const { x, y } = blipXY(90, 250, 500)
    expect(x).toBeCloseTo(0.46, 2)
    expect(y).toBeCloseTo(0, 5)
  })

  it('behind sits below centre', () => {
    const { y } = blipXY(180, 250, 500)
    expect(y).toBeCloseTo(0.46, 2)
  })

  it('clamps beyond-range targets to the rim instead of drawing off-scope', () => {
    const { x, y } = blipXY(0, 5000, 500)
    expect(Math.hypot(x, y)).toBeCloseTo(BLIP_MAX_RADIUS, 5)
  })
})

describe('niceRange', () => {
  it('picks the first round step that keeps the blip inside the rim', () => {
    expect(niceRange(80)).toBe(100)
    expect(niceRange(90)).toBe(250) // 90 × 1.15 > 100
    expect(niceRange(400)).toBe(500)
    expect(niceRange(800)).toBe(1000)
  })

  it('defaults sensibly with no distance yet', () => {
    expect(niceRange(null)).toBe(500)
  })

  it('clamps to the largest scope rather than inventing one', () => {
    expect(niceRange(200_000)).toBe(50_000)
  })

  // The last-approach zoom: the endgame (guidance runs to ~2 m) must fill the
  // scope, not crawl around the centre of a 100 m one.
  it('zooms to fine scopes for the final approach', () => {
    expect(niceRange(35)).toBe(50)
    expect(niceRange(20)).toBe(25)
    expect(niceRange(8)).toBe(10)
    expect(niceRange(3)).toBe(10) // the floor — tighter would render GPS noise
  })

  // HONESTY: the scope never zooms tighter than the disclosed uncertainty —
  // a loose share must keep its honesty band inside the rim, not gain a
  // precise-looking close-up it never disclosed.
  it('never zooms below the disclosed uncertainty', () => {
    expect(niceRange(20, 610)).toBe(1000) // coarse share stays an area
    expect(niceRange(20, 60)).toBe(100)
    expect(niceRange(20, 2.4)).toBe(25) // exact precision: no effect
  })

  it('holds the last scope when the distance drops out mid-session', () => {
    expect(niceRange(null, 0, 100)).toBe(100)
  })

  describe('hysteresis', () => {
    it('zooms out immediately — a real retreat must never hide at the rim', () => {
      expect(niceRange(60, 0, 50)).toBe(100)
    })

    it('zooms in only once comfortably inside the smaller scope', () => {
      expect(niceRange(21, 0, 50)).toBe(50) // fits 25 at 1.15× but not comfortably
      expect(niceRange(18, 0, 50)).toBe(25) // now well inside — zoom in
    })

    it('does not flap across a step boundary on GPS jitter', () => {
      let range = niceRange(18, 0, 50)
      expect(range).toBe(25) // zoomed in at 18 m…
      range = niceRange(21, 0, range)
      expect(range).toBe(25) // …a 3 m jitter back does not zoom out…
      range = niceRange(18, 0, range)
      expect(range).toBe(25) // …and settling again changes nothing
    })

    it('stays put when the ideal scope is unchanged', () => {
      expect(niceRange(20, 0, 25)).toBe(25)
    })
  })
})

describe('freshnessLabel', () => {
  it('reads naturally at each age', () => {
    expect(freshnessLabel(3)).toBe('just now')
    expect(freshnessLabel(18)).toBe('18 s old')
    expect(freshnessLabel(240)).toBe('4 min old')
    expect(freshnessLabel(7300)).toBe('2 h old')
  })
})

describe('statusCopy', () => {
  const fmt = (m: number): string => `~${Math.round(m)} m`
  const base = { me: { lat: 0, lon: 0 }, headingDeg: 0 }

  it('is silent (empty) when guidance is fully live — no chrome in the way', () => {
    const g = radarGuidance({ ...base, target: { position: { lat: 0.01, lon: 0 }, uncertaintyMetres: 2.4, ageSeconds: 5 } })
    expect(statusCopy(g, fmt)).toBe('')
  })

  it('says plainly when there is nothing to navigate to', () => {
    const g = radarGuidance({ ...base, target: null })
    expect(statusCopy(g, fmt)).toMatch(/No location/i)
  })

  it('names a coarse share as a rough area with its size', () => {
    const g = radarGuidance({ ...base, target: { position: { lat: 0.01, lon: 0 }, uncertaintyMetres: 610, ageSeconds: 5 } })
    expect(statusCopy(g, fmt)).toContain('610 m')
    expect(statusCopy(g, fmt)).toMatch(/rough area/i)
  })

  it('admits a stale position and a missing compass in plain words', () => {
    const stale = radarGuidance({ ...base, target: { position: { lat: 0.01, lon: 0 }, uncertaintyMetres: 2.4, ageSeconds: 700 } })
    expect(statusCopy(stale, fmt)).toMatch(/stale/i)
    const noCompass = radarGuidance({ ...base, headingDeg: null, target: { position: { lat: 0.01, lon: 0 }, uncertaintyMetres: 2.4, ageSeconds: 5 } })
    expect(statusCopy(noCompass, fmt)).toMatch(/compass/i)
  })
})
