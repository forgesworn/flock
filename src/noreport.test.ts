import { describe, it, expect } from 'vitest'
import { inNoReportZone, noReportPolicyAt, type NoReportZone } from './noreport.js'

const home: NoReportZone = {
  area: { kind: 'circle', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 150 },
  policy: 'withhold',
  label: 'Home',
}
const nans: NoReportZone = {
  area: { kind: 'circle', centre: { lat: 52.0, lon: -1.0 }, radiusMetres: 200 },
  policy: 'coarse',
  label: "Nan's",
}

describe('no-report zones', () => {
  it('detects a point inside a zone', () => {
    expect(inNoReportZone({ lat: 51.5, lon: -0.1 }, [home, nans])).toBe(true)
  })

  it('detects a point outside every zone', () => {
    expect(inNoReportZone({ lat: 48.0, lon: 2.0 }, [home, nans])).toBe(false)
  })

  it('returns the policy of the containing zone', () => {
    expect(noReportPolicyAt({ lat: 51.5, lon: -0.1 }, [home, nans])).toBe('withhold')
    expect(noReportPolicyAt({ lat: 52.0, lon: -1.0 }, [home, nans])).toBe('coarse')
  })

  it('returns null outside every zone', () => {
    expect(noReportPolicyAt({ lat: 48.0, lon: 2.0 }, [home, nans])).toBeNull()
  })

  it('the strictest overlapping policy wins (withhold beats coarse)', () => {
    const overlap: NoReportZone = {
      area: { kind: 'circle', centre: { lat: 52.0, lon: -1.0 }, radiusMetres: 150 },
      policy: 'withhold',
    }
    expect(noReportPolicyAt({ lat: 52.0, lon: -1.0 }, [nans, overlap])).toBe('withhold')
  })

  it('defaults an unspecified policy to withhold', () => {
    const z: NoReportZone = { area: { kind: 'circle', centre: { lat: 0, lon: 0 }, radiusMetres: 100 } }
    expect(noReportPolicyAt({ lat: 0, lon: 0 }, [z])).toBe('withhold')
  })
})
