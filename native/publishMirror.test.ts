import { describe, it, expect, vi } from 'vitest'
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

  it('is null when Tor routing is on (no native Orbot/SOCKS route — must not leak clearnet)', () => {
    const p = base(); p.torRelay = true
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('is null with no active circle', () => {
    const p = base(); p.activeCircleId = null
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('is null when the active circle is Private posture — the background publisher must never beacon it', () => {
    // `sharing` is global and switchCircle doesn't reset it, so a user who shares
    // in an Always circle then switches focus to a Private one would otherwise have
    // the native task keep publishing the Private circle from a killed WebView.
    const p = base(); p.circles[0].trackingDefault = 'private'
    expect(buildNativePublishConfig(p, true, 7)).toBeNull()
  })

  it('still mirrors an explicit Always circle', () => {
    const p = base(); p.circles[0].trackingDefault = 'always'
    expect(buildNativePublishConfig(p, true, 7)?.circleId).toBe('c1')
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

describe('clear/sync sentinel behaviour', () => {
  it('a failed clear forces the next null sync to retry', async () => {
    vi.resetModules()
    const clearConfig = vi.fn().mockRejectedValueOnce(new Error('ipc down')).mockResolvedValue(undefined)
    vi.doMock('@capacitor/core', () => ({ registerPlugin: () => ({ clearConfig, setConfig: vi.fn(), getJournal: vi.fn(), ackJournal: vi.fn() }) }))
    const m = await import('./publishMirror')
    await m.clearNativePublish()            // fails — sentinel must become RETRY
    await m.syncNativePublishConfig(null)   // must retry the clear, not no-op
    expect(clearConfig).toHaveBeenCalledTimes(2)
    vi.doUnmock('@capacitor/core')
  })

  it('wipeNativePublish calls wipeAll — the full teardown, not the config-only clear', async () => {
    vi.resetModules()
    const clearConfig = vi.fn().mockResolvedValue(undefined)
    const wipeAll = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@capacitor/core', () => ({ registerPlugin: () => ({ clearConfig, wipeAll, setConfig: vi.fn(), getJournal: vi.fn(), ackJournal: vi.fn() }) }))
    const m = await import('./publishMirror')
    await m.wipeNativePublish()
    expect(wipeAll).toHaveBeenCalledTimes(1)
    expect(clearConfig).not.toHaveBeenCalled()
    vi.doUnmock('@capacitor/core')
  })

  it('a failed wipe forces the next null sync to retry — via clearConfig, not wipeAll', async () => {
    vi.resetModules()
    const clearConfig = vi.fn().mockResolvedValue(undefined)
    const wipeAll = vi.fn().mockRejectedValueOnce(new Error('ipc down'))
    vi.doMock('@capacitor/core', () => ({ registerPlugin: () => ({ clearConfig, wipeAll, setConfig: vi.fn(), getJournal: vi.fn(), ackJournal: vi.fn() }) }))
    const m = await import('./publishMirror')
    await m.wipeNativePublish()            // fails — sentinel must become RETRY
    // syncNativePublishConfig only ever knows how to clear via clearConfig — it
    // has no wipe path — so the retry that lands is the coarser config-only
    // clear, not a repeat of the wipe. That's acceptable: the sentinel's job is
    // only to stop the module wedging silently, not to guarantee which native
    // call retries.
    await m.syncNativePublishConfig(null)
    expect(wipeAll).toHaveBeenCalledTimes(1)
    expect(clearConfig).toHaveBeenCalledTimes(1)
    vi.doUnmock('@capacitor/core')
  })

  it('lockNativePublish makes sync a permanent no-op but clear still tears down', async () => {
    vi.resetModules()
    const setConfig = vi.fn().mockResolvedValue(undefined)
    const clearConfig = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@capacitor/core', () => ({ registerPlugin: () => ({ clearConfig, setConfig, getJournal: vi.fn(), ackJournal: vi.fn() }) }))
    const m = await import('./publishMirror')
    m.lockNativePublish()
    await m.syncNativePublishConfig({
      v: 1, skHex: 'aa'.repeat(32), circleId: 'c1', seedHex: 'cc'.repeat(32),
      precision: 7, festivalUntil: 0, relayUrls: ['wss://r1'], noReportZones: [], offGridUntil: 0,
    })
    expect(setConfig).not.toHaveBeenCalled()
    await m.clearNativePublish()
    expect(clearConfig).toHaveBeenCalledTimes(1)
    vi.doUnmock('@capacitor/core')
  })
})
