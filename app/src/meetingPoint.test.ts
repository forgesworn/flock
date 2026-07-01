import { describe, it, expect } from 'vitest'
import { suggestMeetingPoint, onDeviceEngine } from './meetingPoint'

// Three points around central London (all within a ~1.5 km walk of each other).
const A = { lat: 51.5074, lon: -0.1278, label: 'Alice' }
const B = { lat: 51.5155, lon: -0.1410, label: 'Bob' }
const C = { lat: 51.5033, lon: -0.1195, label: 'Carol' }
const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi

describe('suggestMeetingPoint (on-device, centroid-first)', () => {
  it('needs at least two people', async () => {
    await expect(suggestMeetingPoint([A])).rejects.toThrow(/two people/i)
  })

  it('suggests a point inside the group, reachable by everyone, with a time per person', async () => {
    const [s] = await suggestMeetingPoint([A, B, C], { mode: 'walk', maxTimeMinutes: 30 })
    const lats = [A, B, C].map((p) => p.lat)
    const lons = [A, B, C].map((p) => p.lon)
    expect(within(s.venue.lat, Math.min(...lats) - 0.01, Math.max(...lats) + 0.01)).toBe(true)
    expect(within(s.venue.lon, Math.min(...lons) - 0.01, Math.max(...lons) + 0.01)).toBe(true)
    expect(Object.keys(s.travelTimes)).toEqual(['Alice', 'Bob', 'Carol'])
    for (const t of Object.values(s.travelTimes)) expect(t).toBeLessThan(30)
  })

  it('min_max fairness score is the worst-case travel time', async () => {
    const [s] = await suggestMeetingPoint([A, B, C], { fairness: 'min_max', mode: 'walk' })
    expect(s.fairnessScore).toBeCloseTo(Math.max(...Object.values(s.travelTimes)), 5)
  })

  it('min_total fairness score is the sum of travel times', async () => {
    const [s] = await suggestMeetingPoint([A, B, C], { fairness: 'min_total', mode: 'walk' })
    const sum = Object.values(s.travelTimes).reduce((a, b) => a + b, 0)
    expect(s.fairnessScore).toBeCloseTo(sum, 5)
  })

  it('falls back to the group centroid when the isochrones do not overlap', async () => {
    const london = { lat: 51.5, lon: -0.12, label: 'X' }
    const paris = { lat: 48.85, lon: 2.35, label: 'Y' }
    const [s] = await suggestMeetingPoint([london, paris], { mode: 'walk', maxTimeMinutes: 15 })
    expect(s.venue.lat).toBeCloseTo((51.5 + 48.85) / 2, 2)
    expect(s.venue.lon).toBeCloseTo((-0.12 + 2.35) / 2, 2)
  })

  it('the on-device isochrone is a polygon whose radius scales with speed × time (no network)', async () => {
    const origin = { lat: 51.5, lon: -0.12 }
    const walk60 = await onDeviceEngine.computeIsochrone(origin, 'walk', 60)
    const drive60 = await onDeviceEngine.computeIsochrone(origin, 'drive', 60)
    expect(walk60.polygon.type).toBe('Polygon')
    // drive (30 km/h) reaches further from the origin than walk (5 km/h) in the same hour.
    const reach = (poly: { coordinates: number[][][] }) =>
      Math.max(...poly.coordinates[0].map(([lon, lat]) => Math.hypot(lon - origin.lon, lat - origin.lat)))
    expect(reach(drive60.polygon)).toBeGreaterThan(reach(walk60.polygon))
  })
})
