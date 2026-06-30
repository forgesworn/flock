import { describe, it, expect } from 'vitest'
import { decideEmission, DEFAULT_PRECISIONS, type EmissionContext, type EmissionPlan } from './policy.js'
import type { CircleGeofence, LatLng } from './geofence.js'
import type { NoReportZone, NoReportPolicy } from './noreport.js'

/**
 * Exhaustive truth-table for `decideEmission` — the disclosure-on-event core.
 *
 * Where `policy.test.ts` pins the named corner cases, this sweeps EVERY
 * permutation of the decision inputs and checks two things for each:
 *
 *   1. a differential oracle (`expected`, derived independently from the module
 *      JSDoc's documented precedence), and
 *   2. a set of impl-independent SAFETY INVARIANTS — the properties that must
 *      hold no matter how the policy is refactored (an SOS always fires; nothing
 *      is ever emitted without a position; off-grid never silences a trigger; a
 *      no-report zone never pins a sensitive address at full precision).
 *
 * 2 modes × 3 triggers × 2 off-grid × 2 position × 3 geofence × 3 no-report
 * = 216 combinations.
 */

const LONDON: LatLng = { lat: 51.5074, lon: -0.1278 }
const PARIS: LatLng = { lat: 48.8566, lon: 2.3522 }

// A fence that CONTAINS London, and one that does NOT (it is around Paris).
const FENCE_INSIDE: CircleGeofence = { kind: 'circle', centre: LONDON, radiusMetres: 1000 }
const FENCE_OUTSIDE: CircleGeofence = { kind: 'circle', centre: PARIS, radiusMetres: 1000 }

// A no-report zone sitting on London, at each suppression strength.
const nrZone = (policy: NoReportPolicy): NoReportZone => ({
  area: { kind: 'circle', centre: LONDON, radiusMetres: 150 },
  policy,
})

const P = DEFAULT_PRECISIONS

type Mode = 'family' | 'nightout'
type Trigger = 'none' | 'pickup' | 'help'
type Geo = 'none' | 'inside' | 'outside'
type Nr = 'none' | 'withhold' | 'coarse'

const MODES: Mode[] = ['family', 'nightout']
const TRIGGERS: Trigger[] = ['none', 'pickup', 'help']
const OFFGRID = [false, true]
const HASPOS = [true, false]
const GEOS: Geo[] = ['none', 'inside', 'outside']
const NRS: Nr[] = ['none', 'withhold', 'coarse']

function geofences(geo: Geo): CircleGeofence[] {
  if (geo === 'none') return []
  if (geo === 'inside') return [FENCE_INSIDE]
  return [FENCE_OUTSIDE]
}

function noReportZones(nr: Nr): NoReportZone[] {
  return nr === 'none' ? [] : [nrZone(nr)]
}

/**
 * Independent reference derivation of the expected plan, written from the
 * documented precedence in policy.ts — NOT a copy of its branch structure.
 */
function expected(mode: Mode, trigger: Trigger, offGrid: boolean, hasPos: boolean, geo: Geo, nr: Nr): EmissionPlan {
  // 1. Base decision (before the no-report cap).
  let base: EmissionPlan
  if (trigger === 'help') {
    base = hasPos ? { action: 'full', precision: P.help, reason: 'help' } : { action: 'withhold', precision: 0, reason: 'help' }
  } else if (trigger === 'pickup') {
    base = hasPos ? { action: 'full', precision: P.full, reason: 'pickup' } : { action: 'withhold', precision: 0, reason: 'pickup' }
  } else if (offGrid) {
    base = { action: 'withhold', precision: 0, reason: 'none' }
  } else if (!hasPos) {
    base = { action: 'withhold', precision: 0, reason: 'none' }
  } else if (mode === 'family') {
    base = geo === 'outside'
      ? { action: 'full', precision: P.full, reason: 'breach' }
      : { action: 'withhold', precision: 0, reason: 'none' }
  } else {
    base = { action: 'coarse', precision: P.coarse, reason: 'nightout' }
  }

  // 2. No-report cap — only when we have a position inside a zone.
  if (hasPos && nr !== 'none' && base.action !== 'withhold') {
    if (nr === 'withhold') return { action: 'withhold', precision: 0, reason: base.reason }
    return { action: 'coarse', precision: Math.min(base.precision, P.coarse), reason: base.reason }
  }
  return base
}

describe('decideEmission — exhaustive truth-table (216 permutations)', () => {
  for (const mode of MODES)
    for (const trigger of TRIGGERS)
      for (const offGrid of OFFGRID)
        for (const hasPos of HASPOS)
          for (const geo of GEOS)
            for (const nr of NRS) {
              const name = `mode=${mode} trigger=${trigger} offGrid=${offGrid} pos=${hasPos ? 'yes' : 'no'} geo=${geo} noreport=${nr}`
              it(name, () => {
                const ctx: EmissionContext = {
                  mode,
                  position: hasPos ? LONDON : null,
                  trigger,
                  geofences: geofences(geo),
                  offGrid,
                  noReportZones: noReportZones(nr),
                }
                const plan = decideEmission(ctx)

                // (a) Differential oracle.
                expect(plan).toEqual(expected(mode, trigger, offGrid, hasPos, geo, nr))

                // (b) Safety invariants — true for EVERY row, independent of impl.

                // Shape is always valid.
                expect(['withhold', 'coarse', 'full']).toContain(plan.action)
                expect(['none', 'nightout', 'breach', 'pickup', 'help']).toContain(plan.reason)
                if (plan.action === 'withhold') expect(plan.precision).toBe(0)
                else {
                  expect(plan.precision).toBeGreaterThanOrEqual(1)
                  expect(plan.precision).toBeLessThanOrEqual(11)
                }

                // An explicit trigger's intent is NEVER lost — its reason survives
                // off-grid, no-report, even a missing position.
                if (trigger === 'help') expect(plan.reason).toBe('help')
                if (trigger === 'pickup') expect(plan.reason).toBe('pickup')

                // Nothing is ever emitted without a position.
                if (!hasPos) expect(plan.action).toBe('withhold')

                // Off-grid silences only AUTOMATIC emission: with no explicit
                // trigger it must withhold; with one it must still go out
                // (unless a no-report withhold zone caps it — handled below).
                if (offGrid && trigger === 'none') {
                  expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'none' })
                }

                // A no-report zone never pins a sensitive address at full precision —
                // inside one, an emission is at most coarse, even for an SOS.
                if (hasPos && nr !== 'none' && plan.action !== 'withhold') {
                  expect(plan.action).toBe('coarse')
                  expect(plan.precision).toBeLessThanOrEqual(P.coarse)
                }
                // A withhold zone emits no coordinates at all.
                if (hasPos && nr === 'withhold') expect(plan.action).toBe('withhold')

                // An SOS is never fully silenced: off-grid alone cannot stop it
                // (only a no-report WITHHOLD zone removes its coordinates, and even
                // then the help reason is retained for a location-less alert).
                if (trigger === 'help') {
                  if (hasPos && nr === 'withhold') {
                    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'help' })
                  } else if (hasPos) {
                    expect(plan.action === 'full' || plan.action === 'coarse').toBe(true)
                  }
                }
              })
            }
})

describe('decideEmission — cross-cutting safety properties (named)', () => {
  it('off-grid never silences an SOS that has a position (no no-report zone)', () => {
    for (const mode of MODES) {
      const plan = decideEmission({ mode, position: LONDON, trigger: 'help', offGrid: true })
      expect(plan).toEqual({ action: 'full', precision: P.help, reason: 'help' })
    }
  })

  it('a withhold no-report zone keeps the help reason but drops coordinates (location-less SOS)', () => {
    const plan = decideEmission({
      mode: 'family', position: LONDON, trigger: 'help', offGrid: true,
      noReportZones: noReportZones('withhold'),
    })
    expect(plan).toEqual({ action: 'withhold', precision: 0, reason: 'help' })
  })

  it('a coarse no-report zone downgrades an SOS to a grid cell but it still fires', () => {
    const plan = decideEmission({
      mode: 'family', position: LONDON, trigger: 'help',
      noReportZones: noReportZones('coarse'),
    })
    expect(plan).toEqual({ action: 'coarse', precision: P.coarse, reason: 'help' })
  })

  it('family withholds inside a safe zone but discloses on a breach', () => {
    expect(decideEmission({ mode: 'family', position: LONDON, geofences: [FENCE_INSIDE] }).action).toBe('withhold')
    expect(decideEmission({ mode: 'family', position: LONDON, geofences: [FENCE_OUTSIDE] }).reason).toBe('breach')
  })
})
