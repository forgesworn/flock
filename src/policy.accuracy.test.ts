import { describe, it, expect } from 'vitest'
import { decideEmission, DEFAULT_PRECISIONS } from './policy.js'
import type { LatLng, CircleGeofence } from './geofence.js'

// Accuracy-aware breach: a family disclosure fires only when the fix is
// CONFIDENTLY outside every safe zone. An imprecise fix near an edge must never
// cry wolf (false breach) — the caller escalates to a sharper fix instead.

const LONDON: LatLng = { lat: 51.5074, lon: -0.1278 }
const P = DEFAULT_PRECISIONS

/** Shift a point east by `metres`. */
const east = (p: LatLng, m: number): LatLng => ({ lat: p.lat, lon: p.lon + m / (111_320 * Math.cos((p.lat * Math.PI) / 180)) })
const fence: CircleGeofence = { kind: 'circle', centre: LONDON, radiusMetres: 100 }

describe('decideEmission — accuracy-aware family breach', () => {
  it('fires a breach when confidently outside every safe zone', () => {
    const plan = decideEmission({ mode: 'family', position: east(LONDON, 300), geofences: [fence], accuracyMetres: 20 })
    expect(plan).toEqual({ action: 'full', precision: P.full, reason: 'breach' })
  })

  it('does NOT fire when the fix is too imprecise to tell (uncertain → withhold)', () => {
    // 150 m from centre but ±80 m straddles the 100 m edge — cannot assert a breach.
    const plan = decideEmission({ mode: 'family', position: east(LONDON, 150), geofences: [fence], accuracyMetres: 80 })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'none' })
  })

  it('does NOT fire when confidently inside', () => {
    const plan = decideEmission({ mode: 'family', position: east(LONDON, 40), geofences: [fence], accuracyMetres: 20 })
    expect(plan.action).toBe('withhold')
  })

  it('defaults to exact (accuracy 0) — a bare outside fix still breaches', () => {
    const plan = decideEmission({ mode: 'family', position: east(LONDON, 150), geofences: [fence] })
    expect(plan.reason).toBe('breach')
  })

  it('SAFETY: a fix that is not confidently outside never emits a breach, at any accuracy', () => {
    // A point just outside the edge (110 m); sweep the uncertainty from tiny to huge.
    const nearEdge = east(LONDON, 110)
    for (const acc of [0, 5, 9, 10, 11, 50, 200, 1000]) {
      const plan = decideEmission({ mode: 'family', position: nearEdge, geofences: [fence], accuracyMetres: acc })
      // With acc < 10 it is confidently outside (breach); with acc >= 10 it straddles
      // → must withhold. Either way it must NEVER be a false, low-confidence breach.
      if (plan.reason === 'breach') expect(acc).toBeLessThan(10)
      else expect(plan.action).toBe('withhold')
    }
  })
})

describe('decideEmission — accuracy is scoped to family breach only', () => {
  it('never changes an explicit SOS (fires regardless of accuracy)', () => {
    const plan = decideEmission({ mode: 'family', position: LONDON, trigger: 'help', geofences: [fence], accuracyMetres: 5000 })
    expect(plan).toEqual({ action: 'full', precision: P.help, reason: 'help' })
  })

  it('never changes a night-out coarse share (no fences involved)', () => {
    const plan = decideEmission({ mode: 'nightout', position: LONDON, accuracyMetres: 5000 })
    expect(plan).toEqual({ action: 'coarse', precision: P.coarse, reason: 'nightout' })
  })
})
