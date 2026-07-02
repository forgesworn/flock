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

describe('decideEmission — accuracy never suppresses an explicit trigger', () => {
  it('never changes an explicit SOS (fires regardless of accuracy)', () => {
    const plan = decideEmission({ mode: 'family', position: LONDON, trigger: 'help', geofences: [fence], accuracyMetres: 5000 })
    expect(plan).toEqual({ action: 'full', precision: P.help, reason: 'help' })
  })

  it('never changes a night-out coarse share (no fences involved)', () => {
    const plan = decideEmission({ mode: 'nightout', position: LONDON, accuracyMetres: 5000 })
    expect(plan).toEqual({ action: 'coarse', precision: P.coarse, reason: 'nightout' })
  })
})

// The no-report cap fails safe in the OPPOSITE direction to breach: a fix that
// might be over a sensitive address (uncertain) must be capped; only a fix
// confidently outside the zone escapes. A noisy GPS fix at home during an SOS
// must never pin the address.
describe('decideEmission — accuracy-aware no-report cap (possibly inside ⇒ capped)', () => {
  const home: LatLng = { lat: 51.5074, lon: -0.1278 }
  const withholdZone = { area: { kind: 'circle', centre: home, radiusMetres: 100 } as CircleGeofence }
  const coarseZone = { area: { kind: 'circle', centre: home, radiusMetres: 100 } as CircleGeofence, policy: 'coarse' as const }

  it('an SOS on an uncertain fix near a withhold zone still fires, but location-less', () => {
    // 150 m from home, ±80 m — cannot rule out being at home → withhold the address.
    const plan = decideEmission({ mode: 'family', position: east(home, 150), trigger: 'help', noReportZones: [withholdZone], accuracyMetres: 80 })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'help' })
  })

  it('a pick-up on an uncertain fix near a coarse zone is downgraded to coarse', () => {
    const plan = decideEmission({ mode: 'family', position: east(home, 150), trigger: 'pickup', noReportZones: [coarseZone], accuracyMetres: 80 })
    expect(plan).toEqual({ action: 'coarse', precision: P.coarse, reason: 'pickup' })
  })

  it('confidently outside the zone → no cap, full precision', () => {
    const plan = decideEmission({ mode: 'family', position: east(home, 300), trigger: 'help', noReportZones: [withholdZone], accuracyMetres: 20 })
    expect(plan).toEqual({ action: 'full', precision: P.help, reason: 'help' })
  })

  it('a night-out coarse share on an uncertain fix near a withhold zone emits nothing', () => {
    const plan = decideEmission({ mode: 'nightout', position: east(home, 150), noReportZones: [withholdZone], accuracyMetres: 80 })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'nightout' })
  })

  it('SAFETY: a fix not confidently outside a withhold zone never discloses, at any accuracy', () => {
    // Just outside the edge (110 m); sweep the uncertainty from tiny to huge.
    const nearEdge = east(home, 110)
    for (const acc of [0, 5, 9, 10, 11, 50, 200, 1000]) {
      const plan = decideEmission({ mode: 'family', position: nearEdge, trigger: 'help', noReportZones: [withholdZone], accuracyMetres: acc })
      // With acc < 10 the fix is confidently outside (full disclosure is fine);
      // at acc >= 10 it straddles the edge → the address must be withheld.
      if (plan.action === 'full') expect(acc).toBeLessThan(10)
      else expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'help' })
    }
  })
})
