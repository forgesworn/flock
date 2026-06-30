import { describe, it, expect } from 'vitest'
import {
  haversineMetres,
  isInsideCircle,
  isInsidePolygon,
  isInside,
  isBreach,
  type CircleGeofence,
  type PolygonGeofence,
  type LatLng,
} from './geofence.js'

const LONDON: LatLng = { lat: 51.5074, lon: -0.1278 }
const PARIS: LatLng = { lat: 48.8566, lon: 2.3522 }
// ~111 m due north of London (0.001° latitude).
const NEAR_LONDON: LatLng = { lat: 51.5084, lon: -0.1278 }

describe('haversineMetres', () => {
  it('is zero for identical points', () => {
    expect(haversineMetres(LONDON, LONDON)).toBe(0)
  })

  it('matches the known London↔Paris great-circle distance (~343 km)', () => {
    const d = haversineMetres(LONDON, PARIS)
    expect(d).toBeGreaterThan(340_000)
    expect(d).toBeLessThan(345_000)
  })

  it('is symmetric', () => {
    expect(haversineMetres(LONDON, PARIS)).toBeCloseTo(haversineMetres(PARIS, LONDON), 6)
  })

  it('rejects out-of-range coordinates', () => {
    expect(() => haversineMetres({ lat: 200, lon: 0 }, LONDON)).toThrow()
    expect(() => haversineMetres(LONDON, { lat: 0, lon: 999 })).toThrow()
  })
})

describe('isInsideCircle', () => {
  const fence: CircleGeofence = { kind: 'circle', centre: LONDON, radiusMetres: 1000 }

  it('the centre is inside', () => {
    expect(isInsideCircle(LONDON, fence)).toBe(true)
  })

  it('a point ~111 m away is inside a 1 km fence', () => {
    expect(isInsideCircle(NEAR_LONDON, fence)).toBe(true)
  })

  it('a point ~343 km away is outside', () => {
    expect(isInsideCircle(PARIS, fence)).toBe(false)
  })

  it('rejects a non-positive radius', () => {
    expect(() => isInsideCircle(LONDON, { kind: 'circle', centre: LONDON, radiusMetres: 0 })).toThrow()
  })
})

describe('isInsidePolygon', () => {
  // Unit square spanning lat 0..1, lon 0..1.
  const square: PolygonGeofence = {
    kind: 'polygon',
    vertices: [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
      { lat: 1, lon: 0 },
    ],
  }

  it('a central point is inside', () => {
    expect(isInsidePolygon({ lat: 0.5, lon: 0.5 }, square)).toBe(true)
  })

  it('a distant point is outside', () => {
    expect(isInsidePolygon({ lat: 2, lon: 2 }, square)).toBe(false)
  })

  it('a point just outside an edge is outside', () => {
    expect(isInsidePolygon({ lat: 0.5, lon: 1.5 }, square)).toBe(false)
  })

  it('rejects a degenerate polygon (<3 vertices)', () => {
    expect(() => isInsidePolygon({ lat: 0, lon: 0 }, {
      kind: 'polygon',
      vertices: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }],
    })).toThrow()
  })
})

describe('isInside / isBreach', () => {
  const circle: CircleGeofence = { kind: 'circle', centre: LONDON, radiusMetres: 1000 }

  it('isInside dispatches on fence kind', () => {
    expect(isInside(LONDON, circle)).toBe(true)
    expect(isInside(PARIS, circle)).toBe(false)
  })

  it('isBreach is the negation of isInside', () => {
    expect(isBreach(LONDON, circle)).toBe(false)
    expect(isBreach(PARIS, circle)).toBe(true)
  })

  it('throws on an unknown fence kind', () => {
    // @ts-expect-error — deliberately invalid kind for the runtime guard
    expect(() => isInside(LONDON, { kind: 'blob', vertices: [] })).toThrow()
  })
})
