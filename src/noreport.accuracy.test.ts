import { describe, it, expect } from 'vitest'
import { inNoReportZone, noReportPolicyAt } from './noreport.js'
import type { NoReportZone } from './noreport.js'
import type { LatLng } from './geofence.js'

// Accuracy-aware no-report cap: the fail-safe direction is the MIRROR of breach.
// A breach fires only when confidently OUTSIDE every safe zone; a no-report cap
// applies unless the fix is confidently outside the zone — a fix that *might* be
// over a sensitive address must never pin it at full precision.

const HOME: LatLng = { lat: 51.5074, lon: -0.1278 }

/** Shift a point east by `metres`. */
const east = (p: LatLng, m: number): LatLng => ({ lat: p.lat, lon: p.lon + m / (111_320 * Math.cos((p.lat * Math.PI) / 180)) })

const withholdZone: NoReportZone = { area: { kind: 'circle', centre: HOME, radiusMetres: 100 }, label: 'Home' }
const coarseZone: NoReportZone = { area: { kind: 'circle', centre: HOME, radiusMetres: 100 }, policy: 'coarse' }

describe('inNoReportZone — accuracy-aware', () => {
  it('treats a fix that might be inside (uncertain) as in-zone', () => {
    // 150 m out but ±80 m straddles the 100 m edge — cannot rule out being home.
    expect(inNoReportZone(east(HOME, 150), [withholdZone], 80)).toBe(true)
  })

  it('is false only when confidently outside', () => {
    expect(inNoReportZone(east(HOME, 300), [withholdZone], 20)).toBe(false)
  })

  it('accuracy omitted collapses to the crisp check (unchanged behaviour)', () => {
    expect(inNoReportZone(east(HOME, 110), [withholdZone])).toBe(false)
    expect(inNoReportZone(east(HOME, 90), [withholdZone])).toBe(true)
  })
})

describe('noReportPolicyAt — accuracy-aware', () => {
  it('an uncertain fix near a withhold zone is capped to withhold', () => {
    expect(noReportPolicyAt(east(HOME, 150), [withholdZone], 80)).toBe('withhold')
  })

  it('an uncertain fix near a coarse zone is capped to coarse', () => {
    expect(noReportPolicyAt(east(HOME, 150), [coarseZone], 80)).toBe('coarse')
  })

  it('confidently outside every zone → no cap', () => {
    expect(noReportPolicyAt(east(HOME, 300), [withholdZone, coarseZone], 20)).toBeNull()
  })

  it('strictest wins across zones: uncertain-withhold beats inside-coarse', () => {
    const farWithhold: NoReportZone = { area: { kind: 'circle', centre: east(HOME, 200), radiusMetres: 100 } }
    // Fix is confidently inside the coarse zone AND uncertain against the
    // withhold zone (its disc straddles that edge) → withhold must win.
    expect(noReportPolicyAt(east(HOME, 50), [coarseZone, farWithhold], 60)).toBe('withhold')
  })

  it('accuracy omitted collapses to the crisp check (unchanged behaviour)', () => {
    expect(noReportPolicyAt(east(HOME, 110), [withholdZone])).toBeNull()
    expect(noReportPolicyAt(east(HOME, 90), [withholdZone])).toBe('withhold')
  })
})
