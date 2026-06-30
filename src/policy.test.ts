import { describe, it, expect } from 'vitest'
import {
  decideEmission,
  isWithinAnyFence,
  DEFAULT_PRECISIONS,
  type EmissionContext,
} from './policy.js'
import type { CircleGeofence, LatLng } from './geofence.js'

const LONDON: LatLng = { lat: 51.5074, lon: -0.1278 }
const PARIS: LatLng = { lat: 48.8566, lon: 2.3522 }

const HOME: CircleGeofence = { kind: 'circle', centre: LONDON, radiusMetres: 1000 }
const SCHOOL: CircleGeofence = { kind: 'circle', centre: PARIS, radiusMetres: 1000 }

describe('isWithinAnyFence', () => {
  it('is true when inside one of several fences', () => {
    expect(isWithinAnyFence(PARIS, [HOME, SCHOOL])).toBe(true)
  })

  it('is false when outside every fence', () => {
    expect(isWithinAnyFence({ lat: 0, lon: 0 }, [HOME, SCHOOL])).toBe(false)
  })

  it('is false with no fences (nothing to be inside)', () => {
    expect(isWithinAnyFence(LONDON, [])).toBe(false)
  })
})

describe('decideEmission — explicit triggers (highest precedence)', () => {
  it('help discloses at maximum precision', () => {
    const plan = decideEmission({ mode: 'family', position: LONDON, trigger: 'help' })
    expect(plan).toEqual({ action: 'full', precision: DEFAULT_PRECISIONS.help, reason: 'help' })
  })

  it('pickup discloses at full precision', () => {
    const plan = decideEmission({ mode: 'family', position: LONDON, trigger: 'pickup' })
    expect(plan).toEqual({ action: 'full', precision: DEFAULT_PRECISIONS.full, reason: 'pickup' })
  })

  it('help with no position withholds location but keeps the help reason', () => {
    const plan = decideEmission({ mode: 'family', position: null, trigger: 'help' })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'help' })
  })

  it('pickup with no position withholds location but keeps the pickup reason', () => {
    const plan = decideEmission({ mode: 'nightout', trigger: 'pickup' })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'pickup' })
  })

  it('help outranks a simultaneous geofence breach', () => {
    const plan = decideEmission({
      mode: 'family',
      position: { lat: 0, lon: 0 }, // outside both fences
      geofences: [HOME, SCHOOL],
      trigger: 'help',
    })
    expect(plan.reason).toBe('help')
  })
})

describe('decideEmission — family mode (withhold unless breach)', () => {
  it('withholds while inside a safe zone', () => {
    const plan = decideEmission({ mode: 'family', position: LONDON, geofences: [HOME] })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'none' })
  })

  it('withholds while inside any one of several safe zones', () => {
    const plan = decideEmission({ mode: 'family', position: PARIS, geofences: [HOME, SCHOOL] })
    expect(plan.action).toBe('withhold')
  })

  it('discloses full precision on a breach (outside every safe zone)', () => {
    const plan = decideEmission({
      mode: 'family',
      position: { lat: 0, lon: 0 },
      geofences: [HOME, SCHOOL],
    })
    expect(plan).toEqual({ action: 'full', precision: DEFAULT_PRECISIONS.full, reason: 'breach' })
  })

  it('withholds when no geofences are defined (nothing to breach)', () => {
    const plan = decideEmission({ mode: 'family', position: LONDON })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'none' })
  })

  it('withholds when position is unavailable', () => {
    const plan = decideEmission({ mode: 'family', position: null, geofences: [HOME] })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'none' })
  })
})

describe('decideEmission — night-out mode (coarse sharing)', () => {
  it('shares a coarse cloaked location with a fix', () => {
    const plan = decideEmission({ mode: 'nightout', position: LONDON })
    expect(plan).toEqual({ action: 'coarse', precision: DEFAULT_PRECISIONS.coarse, reason: 'nightout' })
  })

  it('withholds without a fix', () => {
    const plan = decideEmission({ mode: 'nightout' })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'none' })
  })
})

describe('decideEmission — precision overrides', () => {
  it('honours custom precisions', () => {
    const ctx: EmissionContext = { mode: 'nightout', position: LONDON }
    expect(decideEmission(ctx, { coarse: 4 }).precision).toBe(4)
  })

  it('rejects an out-of-range precision override', () => {
    expect(() => decideEmission({ mode: 'nightout', position: LONDON }, { coarse: 0 })).toThrow()
    expect(() => decideEmission({ mode: 'nightout', position: LONDON }, { full: 12 })).toThrow()
    expect(() => decideEmission({ mode: 'nightout', position: LONDON }, { help: 6.5 })).toThrow()
  })
})
