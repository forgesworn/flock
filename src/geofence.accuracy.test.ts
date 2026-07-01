import { describe, it, expect } from 'vitest'
import { classifyContainment } from './geofence.js'
import type { LatLng, CircleGeofence, PolygonGeofence } from './geofence.js'

// Accuracy-aware containment: does a fix (with its uncertainty radius) sit
// confidently inside a safe zone, confidently outside every one (a breach), or
// too near an edge to tell? Only a confident 'outside' may fire a breach.

const LONDON: LatLng = { lat: 51.5074, lon: -0.1278 }

/** Shift a point east by `metres` (small-offset planar approximation). */
function east(p: LatLng, metres: number): LatLng {
  return { lat: p.lat, lon: p.lon + metres / (111_320 * Math.cos((p.lat * Math.PI) / 180)) }
}

const circle = (centre: LatLng, radiusMetres: number): CircleGeofence => ({ kind: 'circle', centre, radiusMetres })

describe('classifyContainment — circles', () => {
  const fence = circle(LONDON, 100)

  it('is inside when the whole uncertainty disc is within the fence', () => {
    // 50 m from centre, ±10 m → [40, 60] m, all < 100.
    expect(classifyContainment(east(LONDON, 50), 10, [fence])).toBe('inside')
  })

  it('is outside when the whole disc is beyond the fence', () => {
    // 150 m from centre, ±10 m → [140, 160] m, all > 100.
    expect(classifyContainment(east(LONDON, 150), 10, [fence])).toBe('outside')
  })

  it('is uncertain when the disc straddles the boundary from outside', () => {
    // 150 m from centre, ±80 m → [70, 230] m straddles 100.
    expect(classifyContainment(east(LONDON, 150), 80, [fence])).toBe('uncertain')
  })

  it('is uncertain when the disc straddles the boundary from inside', () => {
    // 50 m from centre, ±80 m → [-30, 130] m straddles 100.
    expect(classifyContainment(east(LONDON, 50), 80, [fence])).toBe('uncertain')
  })

  it('collapses to a crisp inside/outside when accuracy is 0', () => {
    expect(classifyContainment(east(LONDON, 50), 0, [fence])).toBe('inside')
    expect(classifyContainment(east(LONDON, 150), 0, [fence])).toBe('outside')
  })

  it('treats the exact boundary as inside (inclusive), like isInside', () => {
    expect(classifyContainment(east(LONDON, 100), 0, [fence])).toBe('inside')
  })
})

describe('classifyContainment — union of fences', () => {
  it('is inside if the disc is within ANY fence, even if outside another', () => {
    const here = circle(LONDON, 100)
    const faraway = circle(east(LONDON, 5000), 100)
    expect(classifyContainment(east(LONDON, 50), 10, [faraway, here])).toBe('inside')
  })

  it('is outside only when confidently beyond EVERY fence', () => {
    const a = circle(LONDON, 100)
    const b = circle(east(LONDON, 400), 100)
    // 250 m east: 250 from A (out), 150 from B (out), ±10 confident of both.
    expect(classifyContainment(east(LONDON, 250), 10, [a, b])).toBe('outside')
  })

  it('is uncertain if near one edge, even when confidently outside the others', () => {
    const a = circle(LONDON, 100)
    const b = circle(east(LONDON, 5000), 100)
    // Straddles A's edge; miles from B → cannot assert a breach.
    expect(classifyContainment(east(LONDON, 150), 80, [a, b])).toBe('uncertain')
  })

  it('is outside with no fences (nothing to be inside of)', () => {
    expect(classifyContainment(LONDON, 10, [])).toBe('outside')
  })
})

describe('classifyContainment — polygons', () => {
  // A ~2.2 km square centred on London.
  const square: PolygonGeofence = {
    kind: 'polygon',
    vertices: [
      { lat: 51.4974, lon: -0.1378 },
      { lat: 51.4974, lon: -0.1178 },
      { lat: 51.5174, lon: -0.1178 },
      { lat: 51.5174, lon: -0.1378 },
    ],
  }

  it('is inside when the disc is well within the polygon', () => {
    expect(classifyContainment(LONDON, 20, [square])).toBe('inside')
  })

  it('is outside when the disc is well beyond the polygon', () => {
    expect(classifyContainment({ lat: 48.8566, lon: 2.3522 }, 20, [square])).toBe('outside')
  })

  it('is uncertain when a large uncertainty box straddles an edge', () => {
    // Just inside the eastern edge (lon ≈ -0.1180), ±150 m box crosses it.
    expect(classifyContainment({ lat: 51.5074, lon: -0.1180 }, 150, [square])).toBe('uncertain')
  })
})

describe('classifyContainment — validation', () => {
  it('rejects a negative or non-finite accuracy', () => {
    expect(() => classifyContainment(LONDON, -1, [circle(LONDON, 100)])).toThrow()
    expect(() => classifyContainment(LONDON, NaN, [circle(LONDON, 100)])).toThrow()
  })

  it('rejects an out-of-range coordinate', () => {
    expect(() => classifyContainment({ lat: 91, lon: 0 }, 10, [circle(LONDON, 100)])).toThrow()
  })
})
