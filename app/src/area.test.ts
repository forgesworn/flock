import { describe, it, expect } from 'vitest'
import { areaBounds, bboxSpanMetres, bboxToExtractArg, bboxContains } from './area'
import type { Geofence, NoReportZone } from '@forgesworn/flock'

const LONDON = { lat: 51.5074, lon: -0.1278 }
const M_PER_DEG = 111_320

describe('areaBounds', () => {
  it('returns null when there is nothing to save', () => {
    expect(areaBounds([], [])).toBeNull()
  })

  it('bounds a single circle by ~radius, symmetric about the centre', () => {
    const c: Geofence = { kind: 'circle', centre: LONDON, radiusMetres: 1000 }
    const b = areaBounds([c], [], { bufferMetres: 0 })!
    expect(b.maxLat - LONDON.lat).toBeCloseTo(1000 / M_PER_DEG, 4)
    // longitude delta is wider than latitude at this latitude (÷ cos φ)
    expect(b.maxLon - LONDON.lon).toBeGreaterThan(b.maxLat - LONDON.lat)
    expect((b.minLat + b.maxLat) / 2).toBeCloseTo(LONDON.lat, 6)
    expect((b.minLon + b.maxLon) / 2).toBeCloseTo(LONDON.lon, 6)
  })

  it('unions safe zones (circle + polygon) and no-report zones', () => {
    const c: Geofence = { kind: 'circle', centre: LONDON, radiusMetres: 500 }
    const poly: Geofence = {
      kind: 'polygon',
      vertices: [{ lat: 51.52, lon: -0.10 }, { lat: 51.53, lon: -0.08 }, { lat: 51.51, lon: -0.07 }],
    }
    const zone: NoReportZone = { area: { kind: 'circle', centre: { lat: 51.49, lon: -0.15 }, radiusMetres: 300 } }
    const b = areaBounds([c, poly], [zone], { bufferMetres: 0 })!
    expect(b.maxLat).toBeGreaterThanOrEqual(51.53) // polygon top
    expect(b.maxLon).toBeGreaterThanOrEqual(-0.07) // polygon right edge
    expect(b.minLat).toBeLessThanOrEqual(51.49) // no-report zone bottom
    expect(b.minLon).toBeLessThanOrEqual(-0.15) // no-report zone left
  })

  it('expands outwards with the buffer', () => {
    const c: Geofence = { kind: 'circle', centre: LONDON, radiusMetres: 1000 }
    const tight = areaBounds([c], [], { bufferMetres: 0 })!
    const padded = areaBounds([c], [], { bufferMetres: 2000 })!
    expect(padded.maxLat).toBeGreaterThan(tight.maxLat)
    expect(padded.minLat).toBeLessThan(tight.minLat)
    expect(padded.maxLon).toBeGreaterThan(tight.maxLon)
    expect(padded.minLon).toBeLessThan(tight.minLon)
  })
})

describe('bboxSpanMetres', () => {
  it('measures a ~11 km town box (the Harrogate extract)', () => {
    const { widthMetres, heightMetres } = bboxSpanMetres({ minLon: -1.62, minLat: 53.94, maxLon: -1.46, maxLat: 54.04 })
    expect(widthMetres).toBeGreaterThan(9_000)
    expect(widthMetres).toBeLessThan(12_000)
    expect(heightMetres).toBeGreaterThan(10_000)
    expect(heightMetres).toBeLessThan(12_000)
  })
})

describe('bboxToExtractArg', () => {
  it('formats min_lon,min_lat,max_lon,max_lat for go-pmtiles --bbox', () => {
    expect(bboxToExtractArg({ minLon: -1.62, minLat: 53.94, maxLon: -1.46, maxLat: 54.04 })).toBe('-1.62,53.94,-1.46,54.04')
  })
})

describe('bboxContains', () => {
  const HARROGATE = { minLon: -1.62, minLat: 53.94, maxLon: -1.46, maxLat: 54.04 }
  it('is true inside the box and false outside (either axis)', () => {
    expect(bboxContains(HARROGATE, 53.99, -1.54)).toBe(true) // centre
    expect(bboxContains(HARROGATE, 53.99, -1.30)).toBe(false) // east of it (Knaresborough-ish)
    expect(bboxContains(HARROGATE, 53.80, -1.54)).toBe(false) // south of it (Leeds-ish)
  })
})
