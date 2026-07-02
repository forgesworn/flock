import { describe, it, expect } from 'vitest'
import { adoptLegacyFences } from './store'
import type { Circle } from './store'
import type { Geofence } from '@forgesworn/flock'

const fence: Geofence = { kind: 'circle', centre: { lat: 51.5074, lon: -0.1278 }, radiusMetres: 300 }
const other: Geofence = { kind: 'circle', centre: { lat: 48.8566, lon: 2.3522 }, radiusMetres: 100 }
const circle = (id: string, extra: Partial<Circle> = {}): Circle =>
  ({ id, seedHex: 'ab'.repeat(32), name: id, mode: 'family', ...extra })

// Safe places used to be device-global and applied to every family circle; the
// per-circle migration must preserve that behaviour exactly — every circle gets
// a copy, nothing is lost, and a circle that already owns a set is untouched.
describe('adoptLegacyFences', () => {
  it('copies legacy fences into every circle', () => {
    const out = adoptLegacyFences([circle('a'), circle('b', { mode: 'nightout' })], [fence])
    expect(out[0].geofences).toEqual([fence])
    expect(out[1].geofences).toEqual([fence])
  })

  it('never overwrites a circle that already has its own set', () => {
    const out = adoptLegacyFences([circle('a', { geofences: [other] })], [fence])
    expect(out[0].geofences).toEqual([other])
  })

  it('no legacy fences → circles unchanged (no empty arrays invented)', () => {
    const out = adoptLegacyFences([circle('a')], undefined)
    expect(out[0].geofences).toBeUndefined()
    expect(adoptLegacyFences([circle('a')], [])[0].geofences).toBeUndefined()
  })

  it('copies are independent per circle (no shared array reference)', () => {
    const out = adoptLegacyFences([circle('a'), circle('b')], [fence])
    expect(out[0].geofences).not.toBe(out[1].geofences)
  })
})
