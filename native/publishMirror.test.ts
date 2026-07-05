import { describe, it, expect } from 'vitest'
import { buildNativePublishConfig } from './publishMirror'
import type { Persisted } from '../app/src/store'

const base = (): Persisted => ({
  identity: { skHex: 'aa'.repeat(32), pk: 'bb'.repeat(32) },
  circles: [{ id: 'c1', seedHex: 'cc'.repeat(32), name: 'x', mode: 'nightout' as const, sharePrecision: 7 }],
  activeCircleId: 'c1',
  relayUrls: ['wss://r1'],
  noReportZones: [{ area: { kind: 'circle' as const, centre: { lat: 1, lon: 2 }, radiusMetres: 50 } }],
  petnames: {}, presence: {},
})

describe('buildNativePublishConfig', () => {
  it('mirrors the active circle with defaulted zone policy', () => {
    const cfg = buildNativePublishConfig(base(), true, 7)
    expect(cfg).toMatchObject({
      v: 1, skHex: 'aa'.repeat(32), circleId: 'c1', seedHex: 'cc'.repeat(32),
      precision: 7, relayUrls: ['wss://r1'], offGridUntil: 0, festivalUntil: 0,
    })
    expect(cfg?.noReportZones[0].policy ?? 'withhold').toBe('withhold')
  })

  it('is null when not sharing', () => {
    expect(buildNativePublishConfig(base(), false, 7)).toBeNull()
  })

  it('is null for a Signet identity (no local key to seal with)', () => {
    const p = base(); p.identity = { pk: 'bb'.repeat(32) }; p.authMethod = 'signet'
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('is null with no active circle', () => {
    const p = base(); p.activeCircleId = null
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('carries festival and off-grid deadlines', () => {
    const p = base()
    p.circles[0].festivalUntil = 123
    p.offGridUntil = 456
    const cfg = buildNativePublishConfig(p, true, 7)
    expect(cfg?.festivalUntil).toBe(123)
    expect(cfg?.offGridUntil).toBe(456)
  })
})
