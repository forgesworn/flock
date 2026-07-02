import { describe, it, expect } from 'vitest'
import { exportBackup, importBackup, applyBackup, collectBackup } from './backup'
import type { Persisted } from './store'

const ALICE = 'a1'.repeat(32)
const persisted = (over: Partial<Persisted> = {}): Persisted => ({
  identity: { skHex: 'c3'.repeat(32), pk: ALICE },
  circles: [
    { id: 'fam1', seedHex: 'ab'.repeat(32), name: 'The Smiths', mode: 'family', members: [ALICE], epoch: 1 },
    { id: 'trip', seedHex: 'cd'.repeat(32), name: 'Trip', mode: 'nightout', expiresAt: 2_000_000_000 },
  ],
  activeCircleId: 'fam1',
  relayUrls: ['wss://relay.trotters.cc'],
  noReportZones: [{ area: { kind: 'circle', centre: { lat: 51.5, lon: -0.12 }, radiusMetres: 300 } }],
  petnames: { [ALICE]: 'Me' },
  presence: {},
  authMethod: 'local',
  circleRootHex: 'ef'.repeat(32),
  ...over,
})

describe('backup — export/import round-trip', () => {
  it('round-trips everything a device needs through the passphrase envelope', async () => {
    const blob = await exportBackup(persisted(), 'correct horse battery staple')
    const data = await importBackup(blob, 'correct horse battery staple')
    expect(data).toEqual(collectBackup(persisted()))
    expect(data.v).toBe(1)
    expect(data.circles).toHaveLength(2)
    expect(data.circleRootHex).toBe('ef'.repeat(32))
  }, 30_000)

  it('the blob is a single copy-paste-able token (no whitespace)', async () => {
    const blob = await exportBackup(persisted(), 'pass phrase here')
    expect(blob).toMatch(/^\S+$/)
  }, 30_000)

  it('a wrong passphrase is rejected', async () => {
    const blob = await exportBackup(persisted(), 'right passphrase')
    await expect(importBackup(blob, 'wrong passphrase')).rejects.toThrow()
  }, 30_000)

  it('garbage input is rejected with a friendly error', async () => {
    await expect(importBackup('not a backup at all', 'x')).rejects.toThrow(/backup/i)
  })

  it('presence cache and relay list stay OUT of the backup (device-specific)', () => {
    const data = collectBackup(persisted({ presence: { fam1: [{ member: ALICE, geohash: 'gcpuuz', precision: 6, timestamp: 1 }] } }))
    expect(JSON.stringify(data)).not.toContain('gcpuuz')
    expect(JSON.stringify(data)).not.toContain('wss://')
  })
})

describe('applyBackup — merge into current device state', () => {
  it('restores onto a fresh device wholesale', () => {
    const fresh: Persisted = { identity: null, circles: [], activeCircleId: null, relayUrls: ['wss://relay.trotters.cc'], noReportZones: [], petnames: {}, presence: {} }
    const out = applyBackup(fresh, collectBackup(persisted()))
    expect(out.identity?.pk).toBe(ALICE)
    expect(out.circles.map((c) => c.id)).toEqual(['fam1', 'trip'])
    expect(out.activeCircleId).toBe('fam1')
    expect(out.circleRootHex).toBe('ef'.repeat(32))
    expect(out.noReportZones).toHaveLength(1)
  })

  it('never clobbers an existing identity or a circle the device already has', () => {
    const current = persisted({ circles: [{ id: 'fam1', seedHex: '11'.repeat(32), name: 'Newer Smiths', mode: 'family' }] })
    const out = applyBackup(current, collectBackup(persisted()))
    expect(out.identity?.skHex).toBe('c3'.repeat(32))
    expect(out.circles.find((c) => c.id === 'fam1')?.seedHex).toBe('11'.repeat(32)) // current wins
    expect(out.circles.some((c) => c.id === 'trip')).toBe(true) // missing circle added
  })
})
